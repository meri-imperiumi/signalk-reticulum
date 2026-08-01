/**
 * Wires up the filesystem-backed {@link StorageAdapter} for the Reticulum node,
 * and pre-emptively persists the data for configured crew members the moment
 * their announces are heard — so their identities and paths survive a restart
 * even before any message has been exchanged.
 *
 * @file storage.js
 */

const { toHex } = require("@reticulum/core");
const { FileStorageAdapter } = require("@reticulum/node");
const { effectiveCrew } = require("./notifications");

/** Injected for testability; defaults to the real @reticulum/node adapter. */
const deps = {
  FileStorageAdapter,
  toHex,
};

/**
 * Creates a filesystem-backed {@link StorageAdapter} rooted at the plugin data
 * directory, or `null` when the server exposes no data directory (older Signal K
 * servers). A `null` adapter disables persistence: the Reticulum node still
 * runs, just without learning peers/ratchets/paths across restarts.
 *
 * @param {string|null|undefined} dataDirPath
 * @param {(...args:any[])=>void} [log]
 * @returns {object|null}
 */
function createStorageAdapter(dataDirPath, log = () => {}) {
  if (!dataDirPath) {
    log("No plugin data directory available; persistence disabled");
    return null;
  }
  const adapter = new deps.FileStorageAdapter(dataDirPath);
  log(`Persisting Reticulum data under ${dataDirPath}`);
  return adapter;
}

/**
 * Listens for transport announces from any destination whose hash is in
 * `hashes` and persists its identity/ratchet/path data pre-emptively through
 * the node's persistor, so a restart can still reach it before any message
 * round-trip happens.
 *
 * Returns an unsubscribe function that detaches the listener (safe to call
 * repeatedly). It is a no-op (returns a no-op unsubscribe) when the node lacks
 * a transport/persistor (persistence disabled, or test fakes) or when no hash
 * is given. `label` is used in the log lines so crew members and the
 * propagation node are distinguishable in the server log. Per-announce
 * failures are logged and never thrown into the transport's event dispatch.
 *
 * @param {{transport?:EventTarget, persistor?:{store(hash:Uint8Array|string, opts?:{announce?:object}):Promise<void>}}|null|undefined} rns
 * @param {string[]} hashes - Destination hashes (lowercase hex) to watch.
 * @param {string} label - Human-readable label used in log lines.
 * @param {(...args:any[])=>void} [log]
 * @returns {() => void}
 */
function watchAnnounces(rns, hashes, label, log = () => {}) {
  const noop = () => {};
  if (!rns || !rns.transport || !rns.persistor) {
    return noop;
  }
  if (!hashes || hashes.length === 0) {
    return noop;
  }
  const watched = new Set(hashes);

  const onAnnounce = (event) => {
    const detail = event && event.detail;
    const destinationHash = detail && detail.destinationHash;
    if (!destinationHash) {
      return;
    }
    const hex = deps.toHex(destinationHash);
    if (!watched.has(hex)) {
      return;
    }
    // Fire-and-forget: failures are logged, never thrown into the transport.
    Promise.resolve(rns.persistor.store(destinationHash, { announce: detail }))
      .then(() => log(`Persisted ${label} ${hex} from announce`))
      .catch((e) => log(`Failed to persist ${label} ${hex}: ${e.message}`));
  };
  rns.transport.addEventListener("announce", onAnnounce);
  return () => {
    try {
      rns.transport.removeEventListener("announce", onAnnounce);
    } catch {
      /* best effort */
    }
  };
}

/**
 * Listens for transport announces from configured crew members and persists
 * their identity/ratchet/path data pre-emptively through the node's persistor,
 * so a restart can still reach them before any message round-trip happens.
 *
 * Returns an unsubscribe function that detaches the listener (safe to call
 * repeatedly). It is a no-op (returns a no-op unsubscribe) when the node lacks a
 * transport/persistor (persistence disabled, or test fakes) or when no crew is
 * configured.
 *
 * @param {{transport?:EventTarget, persistor?:{store(hash:Uint8Array|string, opts?:{announce?:object}):Promise<void>}}|null|undefined} rns
 * @param {unknown} crew - Raw `crew` config (array of `{name, destination}`).
 * @param {(...args:any[])=>void} [log]
 * @returns {() => void}
 */
function setupCrewPersistence(rns, crew, log = () => {}) {
  const members = effectiveCrew(crew, log);
  if (members.length === 0) {
    return () => {};
  }
  return watchAnnounces(
    rns,
    members.map((m) => m.destinationHash),
    "crew member",
    log,
  );
}

/**
 * Listens for a transport announce from the configured LXMF propagation node
 * and persists its identity/path data pre-emptively through the node's
 * persistor, so a restart can sync from it immediately instead of waiting to
 * hear its announce again.
 *
 * Returns an unsubscribe function (no-op when the node lacks a
 * transport/persistor or no hash is given).
 *
 * @param {{transport?:EventTarget, persistor?:{store(hash:Uint8Array|string, opts?:{announce?:object}):Promise<void>}}|null|undefined} rns
 * @param {string} nodeHex - The propagation node's destination hash (hex).
 * @param {(...args:any[])=>void} [log]
 * @returns {() => void}
 */
function setupPropagationNodePersistence(rns, nodeHex, log = () => {}) {
  if (!nodeHex) {
    return () => {};
  }
  return watchAnnounces(rns, [nodeHex], "propagation node", log);
}

module.exports = {
  deps,
  createStorageAdapter,
  watchAnnounces,
  setupCrewPersistence,
  setupPropagationNodePersistence,
};
