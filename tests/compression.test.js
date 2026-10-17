const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deps,
  createBz2Provider,
  compressBufferSize,
  BLOCK_SIZE,
  GUARD_EVENTS,
  snapshotHandlers,
  defuseHandlersAddedSince,
} = require("../plugin/compression");

const REAL_BZIP2 = deps.BZip2;

/** A fake BZip2 that records init/compress/decompress calls. */
class FakeBZip2 {
  constructor() {
    this.initCalls = 0;
    this.compressCalls = [];
    this.decompressCalls = [];
    FakeBZip2.instances.push(this);
  }
  async init() {
    this.initCalls += 1;
  }
  compress(data, blockSize, outLen) {
    this.compressCalls.push({ data, blockSize, outLen });
    // Echo the input so the adapter is observable end-to-end.
    return data;
  }
  decompress(data, size) {
    this.decompressCalls.push({ data, size });
    return data;
  }
}
FakeBZip2.instances = [];

test("compressBufferSize adds ~1% plus a fixed overhead for incompressible input", () => {
  assert.equal(compressBufferSize(0), 600);
  assert.equal(compressBufferSize(100), 100 + 1 + 600);
  assert.equal(compressBufferSize(540), 540 + 6 + 600);
});

test("createBz2Provider initialises the BZip2 instance once", async () => {
  deps.BZip2 = FakeBZip2;
  FakeBZip2.instances.length = 0;
  const logs = [];

  const provider = await createBz2Provider((...a) => logs.push(a.join(" ")));

  assert.equal(FakeBZip2.instances.length, 1, "one BZip2 instance created");
  assert.equal(FakeBZip2.instances[0].initCalls, 1, "init awaited once");
  assert.ok(logs.some((l) => /bzip2 compression provider ready/.test(l)));
  assert.equal(typeof provider.compress, "function");
  assert.equal(typeof provider.decompress, "function");

  deps.BZip2 = REAL_BZIP2;
});

test("compress forwards the data, block size and a generous output buffer", async () => {
  deps.BZip2 = FakeBZip2;
  FakeBZip2.instances.length = 0;

  const provider = await createBz2Provider();
  const impl = FakeBZip2.instances[0];
  const data = new Uint8Array([1, 2, 3, 4]);

  const out = provider.compress(data);

  assert.equal(out, data, "compressed result returned to the caller");
  assert.deepEqual(impl.compressCalls, [
    {
      data,
      blockSize: BLOCK_SIZE,
      outLen: compressBufferSize(data.length),
    },
  ]);

  deps.BZip2 = REAL_BZIP2;
});

test("decompress forwards the body and the uncompressed size", async () => {
  deps.BZip2 = FakeBZip2;
  FakeBZip2.instances.length = 0;

  const provider = await createBz2Provider();
  const impl = FakeBZip2.instances[0];
  const body = new Uint8Array([9, 9, 9]);

  const out = provider.decompress(body, 42);

  assert.equal(out, body, "decompressed result returned to the caller");
  assert.deepEqual(impl.decompressCalls, [{ data: body, size: 42 }]);

  deps.BZip2 = REAL_BZIP2;
});

test("createBz2Provider uses the injected BZip2, not the real module", async () => {
  deps.BZip2 = class extends FakeBZip2 {
    async init() {
      throw new Error("wasm boom");
    }
  };

  await assert.rejects(() => createBz2Provider(), /wasm boom/);

  deps.BZip2 = REAL_BZIP2;
});

// ---------------------------------------------------------------------------
// Emscripten process-global handler defusal
//
// The generated WASM glue installs `process.on('uncaughtException')` and
// `process.on('unhandledRejection')` rethrow handlers at module-evaluation
// time. The unhandledRejection one converts every orphaned rejection in the
// host process — from any plugin — into a thrown, process-killing exception
// (observed 2026-10-17: a shelly2 `connect ECONNRESET` orphan surfaced
// through `bzip2.mjs:168 throw ex` and killed signalk-server). The loader
// must remove exactly the handlers the glue added.
// ---------------------------------------------------------------------------

test("defuseHandlersAddedSince removes only listeners added after the snapshot", () => {
  const event = "unhandledRejection";
  const probe = () => {};
  const landmine = () => {
    throw new Error("emscripten rethrow");
  };
  process.on(event, probe);
  const snap = snapshotHandlers();
  process.on(event, landmine);

  const removed = defuseHandlersAddedSince(snap);

  assert.equal(removed, 1);
  assert.ok(
    process.listeners(event).includes(probe),
    "host listeners must survive",
  );
  assert.ok(
    !process.listeners(event).includes(landmine),
    "glue-installed handlers must be removed",
  );
  process.removeListener(event, probe);
});

test("defusing works for uncaughtException too", () => {
  const event = "uncaughtException";
  const probe = () => {};
  const landmine = () => {};
  process.on(event, probe);
  const snap = snapshotHandlers();
  process.on(event, landmine);

  defuseHandlersAddedSince(snap);

  assert.ok(process.listeners(event).includes(probe));
  assert.ok(!process.listeners(event).includes(landmine));
  process.removeListener(event, probe);
});

test("loading the real bzip2 module leaves no net-new process-global handlers", async () => {
  // Force the lazy loader down the real-module path (tests may have injected
  // a fake earlier; nulling deps.BZip2 re-triggers the load branch, which is
  // a no-op when the module was already evaluated).
  const saved = deps.BZip2;
  deps.BZip2 = null;
  const before = snapshotHandlers();
  try {
    const provider = await createBz2Provider(() => {});
    const after = snapshotHandlers();
    for (const event of GUARD_EVENTS) {
      assert.ok(
        after[event].length <= before[event].length,
        `no net-new ${event} handlers after the bzip2 module load`,
      );
    }
    // The provider still works end-to-end (round-trips through the real WASM).
    const payload = new TextEncoder().encode("defusal smoke test");
    const compressed = provider.compress(payload);
    const decompressed = provider.decompress(compressed, payload.length);
    assert.deepEqual(Array.from(decompressed), Array.from(payload));
  } finally {
    deps.BZip2 = saved;
  }
});
