/**
 * Wires `@digitaldefiance/bzip2-wasm` as the Reticulum `compressionProvider`.
 *
 * The Reticulum Resource layer (PROTOCOL-SPEC.md §10.2) calls
 * `bz2.compress(plaintext)` and `bz2.decompress(body, uncompressedSize)` for
 * optional compression of large link transfers — LXMF direct messages, NomadNet
 * pages and propagation containers. `@digitaldefiance/bzip2-wasm` exposes
 * `compress(data, blockSize, outLen)` and `decompress(data, outLen)` after an
 * asynchronous `init()`.
 *
 * bzip2's worst-case expansion (incompressible input) overflows the module's
 * default output buffer and throws `BZ_OUTBUFF_FULL`, so {@link createBz2Provider}
 * sizes the compress destination buffer generously. Reticulum only keeps the
 * compressed form when it is actually smaller, so the over-allocation never
 * reaches the wire.
 *
 * The BZip2 class is exposed through {@link deps} (lazily loaded, see below)
 * so this module can be unit-tested with a fake instead of loading WASM.
 *
 * ## The Emscripten process-global landmine
 *
 * The generated WASM glue (`bzip2-1.0.8/bzip2.mjs`) installs process-global
 * handlers at module-evaluation time:
 *
 * ```js
 * process.on('uncaughtException', (ex) => {
 *   if (!(ex instanceof ExitStatus)) throw ex;
 * });
 * process.on('unhandledRejection', (reason) => { throw reason; });
 * ```
 *
 * The `unhandledRejection` one is a landmine: it converts *every* unhandled
 * rejection in the host process — from any Signal K plugin, not just ours —
 * into a thrown, process-killing exception. Observed 2026-10-17 19:39 on
 * lille-oe: an orphaned `connect ECONNRESET` rejection from the shelly2
 * plugin surfaced through `bzip2.mjs:168 throw ex` and killed
 * signalk-server. The host's own handling (Signal K logs unhandled
 * rejections; Node's default) is the correct behaviour for a shared server,
 * so {@link loadBZip2} snapshots the listeners around the module load and
 * removes exactly the handlers the glue added.
 *
 * @file compression.js
 */

/** Injected bzip2 implementation; tests swap this for a fake. */
const deps = {
  BZip2: null,
};

/** Emscripten process-global handler names to defuse after the module load. */
const GUARD_EVENTS = ["uncaughtException", "unhandledRejection"];

/**
 * Snapshots the current listeners for the guard events, so the ones added
 * during the WASM module load can be identified and removed afterwards.
 *
 * @returns {Record<string, Function[]>}
 */
function snapshotHandlers() {
  /** @type {Record<string, Function[]>} */
  const snap = {};
  for (const event of GUARD_EVENTS) {
    snap[event] = process.listeners(event);
  }
  return snap;
}

/**
 * Removes exactly the process-global listeners that were added after the
 * given snapshot — i.e. the Emscripten glue's rethrow handlers — leaving the
 * host's own handlers untouched.
 *
 * @param {Record<string, Function[]>} snap - Snapshot from
 *   {@link snapshotHandlers}.
 * @returns {number} Number of defused listeners.
 */
function defuseHandlersAddedSince(snap) {
  let removed = 0;
  for (const event of GUARD_EVENTS) {
    const before = snap[event];
    for (const listener of process.listeners(event)) {
      if (!before.includes(listener)) {
        process.removeListener(event, listener);
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * Lazily loads the real BZip2 class, defusing the Emscripten process-global
 * handlers installed during the module evaluation. Subsequent calls return
 * the loaded class without re-requiring (the real module can only install
 * its handlers once, at first evaluation).
 *
 * @returns {new () => import("@digitaldefiance/bzip2-wasm").default}
 */
function loadBZip2() {
  if (deps.BZip2) return deps.BZip2;
  const snap = snapshotHandlers();
  deps.BZip2 = require("@digitaldefiance/bzip2-wasm").default;
  const removed = defuseHandlersAddedSince(snap);
  if (removed > 0) {
    log(
      `Defused ${removed} process-global handler(s) installed by the ` +
        "bzip2 WASM glue (uncaughtException/unhandledRejection rethrow)",
    );
  }
  return deps.BZip2;
}

/** bzip2 block size passed to compress (5 ⇒ 900 KB blocks, the bzip2 default). */
const BLOCK_SIZE = 5;

/**
 * Sizes the compress output buffer to absorb bzip2's worst-case expansion for
 * incompressible input (≈ 1 % plus a small fixed overhead). Reticulum discards
 * the compressed form whenever it isn't smaller, so over-allocating is harmless.
 *
 * @param {number} inputLen
 * @returns {number}
 */
function compressBufferSize(inputLen) {
  return inputLen + Math.ceil(inputLen / 100) + 600;
}

/** Module-level log sink, set from the first {@link createBz2Provider} call. */
let log = () => {};

/**
 * Builds and initialises a Reticulum compressionProvider backed by bzip2-wasm.
 *
 * The `init()` call is also guarded: the glue may install its process-global
 * handlers at any evaluation point, so the listeners are snapshot before and
 * defused after initialisation too.
 *
 * @param {(...args:any[])=>void} [logFn]
 * @returns {Promise<{compress:(data:Uint8Array)=>Uint8Array, decompress:(data:Uint8Array,size:number)=>Uint8Array}>}
 */
async function createBz2Provider(logFn = () => {}) {
  if (typeof logFn === "function") log = logFn;
  const Impl = loadBZip2();
  const snap = snapshotHandlers();
  const impl = new Impl();
  await impl.init();
  const removed = defuseHandlersAddedSince(snap);
  if (removed > 0) {
    log(
      `Defused ${removed} process-global handler(s) installed during ` +
        "bzip2 WASM init",
    );
  }
  log("bzip2 compression provider ready");
  return {
    /**
     * @param {Uint8Array} data
     * @returns {Uint8Array}
     */
    compress(data) {
      return impl.compress(data, BLOCK_SIZE, compressBufferSize(data.length));
    },
    /**
     * @param {Uint8Array} data
     * @param {number} size
     * @returns {Uint8Array}
     */
    decompress(data, size) {
      return impl.decompress(data, size);
    },
  };
}

module.exports = {
  deps,
  GUARD_EVENTS,
  snapshotHandlers,
  defuseHandlersAddedSince,
  loadBZip2,
  BLOCK_SIZE,
  compressBufferSize,
  createBz2Provider,
};
