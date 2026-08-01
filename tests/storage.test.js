const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const {
  deps,
  createStorageAdapter,
  setupCrewPersistence,
  setupPropagationNodePersistence,
  watchAnnounces,
} = require("../plugin/storage");
const { FileStorageAdapter } = require("@reticulum/node");

const REAL_DEPS = { ...deps };

/** Converts a hex string to a fresh Uint8Array. */
function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

// --- createStorageAdapter ----------------------------------------------------

test("createStorageAdapter returns null and logs when no data dir is available", () => {
  const logs = [];
  const adapter = createStorageAdapter(null, (...a) => logs.push(a.join(" ")));
  assert.equal(adapter, null);
  assert.ok(logs.some((l) => /persistence disabled/i.test(l)));
});

test("createStorageAdapter returns null for undefined or empty data dir", () => {
  assert.equal(createStorageAdapter(undefined), null);
  assert.equal(createStorageAdapter(""), null);
});

test("createStorageAdapter builds a working FileStorageAdapter at the data dir", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "sk-reticulum-storage-"));
  try {
    const logs = [];
    const adapter = createStorageAdapter(dir, (...a) => logs.push(a.join(" ")));
    assert.ok(adapter instanceof FileStorageAdapter);
    assert.equal(adapter.directory, dir);
    assert.ok(logs.some((l) => /Persisting Reticulum data/.test(l)));

    // Smoke-test the real adapter round-trips a record end to end.
    const payload = new Uint8Array([1, 2, 3]);
    await adapter.set("identities", "deadbeef", payload);
    const got = await adapter.get("identities", "deadbeef");
    assert.deepEqual(got, payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- setupCrewPersistence ----------------------------------------------------

/** A crew destination hash used across the announce tests. */
const CREW_DEST = "0123456789abcdef0123456789abcdef";
const CREW = [{ name: "Alice", destination: CREW_DEST }];

/**
 * Builds a fake node with an EventTarget transport and a persistor that records
 * store() calls. Pass `{ persist: false }` to omit the persistor.
 */
function makeFakeRns({ persist = true } = {}) {
  const rns = { transport: new EventTarget() };
  if (persist) {
    rns.persistor = {
      storeCalls: [],
      async store(hash, opts) {
        this.storeCalls.push({ hash, opts });
      },
    };
  }
  return rns;
}

/** Dispatches an "announce" event carrying the given destination hash. */
function announce(rns, destinationHash, extra = {}) {
  rns.transport.dispatchEvent(
    new CustomEvent("announce", {
      detail: {
        destinationHash,
        identity: { publicKey: new Uint8Array() },
        ...extra,
      },
    }),
  );
}

test("setupCrewPersistence is a no-op when the node lacks a transport or persistor", () => {
  assert.equal(typeof setupCrewPersistence(null, CREW), "function");
  assert.equal(typeof setupCrewPersistence({}, CREW), "function");
  const rns = { transport: new EventTarget() }; // no persistor
  assert.equal(typeof setupCrewPersistence(rns, CREW), "function");
});

test("setupCrewPersistence is a no-op when no crew is configured", async () => {
  const rns = makeFakeRns();
  setupCrewPersistence(rns, []);
  announce(rns, hexToBytes(CREW_DEST));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("setupCrewPersistence ignores invalid crew entries", async () => {
  const rns = makeFakeRns();
  setupCrewPersistence(rns, [{ name: "?", destination: "not-a-hash" }]);
  announce(rns, hexToBytes(CREW_DEST));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("setupCrewPersistence stores a crew member when their announce is heard", async () => {
  const logs = [];
  const rns = makeFakeRns();
  setupCrewPersistence(rns, CREW, (...a) => logs.push(a.join(" ")));

  announce(rns, hexToBytes(CREW_DEST), {
    appData: new Uint8Array([9]),
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rns.persistor.storeCalls.length, 1);
  const call = rns.persistor.storeCalls[0];
  assert.deepEqual(call.hash, hexToBytes(CREW_DEST));
  assert.ok(call.opts.announce, "announce detail forwarded to the persistor");
  assert.equal(call.opts.announce.appData[0], 9);
  assert.ok(logs.some((l) => /Persisted crew member/.test(l)));
});

test("setupCrewPersistence ignores announces from non-crew destinations", async () => {
  const rns = makeFakeRns();
  setupCrewPersistence(rns, CREW);
  announce(rns, hexToBytes("fedcba9876543210fedcba9876543210"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("setupCrewPersistence unsubscribe stops further persistence", async () => {
  const rns = makeFakeRns();
  const unsub = setupCrewPersistence(rns, CREW);
  unsub();
  announce(rns, hexToBytes(CREW_DEST));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("setupCrewPersistence logs but does not throw when store fails", async () => {
  const logs = [];
  const rns = makeFakeRns();
  rns.persistor.store = async () => {
    throw new Error("disk full");
  };
  setupCrewPersistence(rns, CREW, (...a) => logs.push(a.join(" ")));
  // Must not throw into the dispatch.
  announce(rns, hexToBytes(CREW_DEST));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(logs.some((l) => /Failed to persist crew member/.test(l)));
});

// --- setupPropagationNodePersistence ---------------------------------------

/** A propagation node destination hash used across the announce tests. */
const PROP_NODE = "fedcba0987654321fedcba0987654321";

test("setupPropagationNodePersistence is a no-op without a node hash", async () => {
  const rns = makeFakeRns();
  setupPropagationNodePersistence(rns, "");
  announce(rns, hexToBytes(PROP_NODE));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("setupPropagationNodePersistence is a no-op when the node lacks a transport or persistor", () => {
  assert.equal(
    typeof setupPropagationNodePersistence(null, PROP_NODE),
    "function",
  );
  const rns = { transport: new EventTarget() }; // no persistor
  assert.equal(
    typeof setupPropagationNodePersistence(rns, PROP_NODE),
    "function",
  );
});

test("setupPropagationNodePersistence stores the node when its announce is heard", async () => {
  const logs = [];
  const rns = makeFakeRns();
  setupPropagationNodePersistence(rns, PROP_NODE, (...a) =>
    logs.push(a.join(" ")),
  );

  announce(rns, hexToBytes(PROP_NODE), { appData: new Uint8Array([5]) });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rns.persistor.storeCalls.length, 1);
  const call = rns.persistor.storeCalls[0];
  assert.deepEqual(call.hash, hexToBytes(PROP_NODE));
  assert.ok(call.opts.announce, "announce detail forwarded to the persistor");
  assert.equal(call.opts.announce.appData[0], 5);
  assert.ok(
    logs.some((l) => /Persisted propagation node/.test(l)),
    "the propagation-node label is used in the log",
  );
});

test("setupPropagationNodePersistence ignores announces from other destinations", async () => {
  const rns = makeFakeRns();
  setupPropagationNodePersistence(rns, PROP_NODE);
  announce(rns, hexToBytes(CREW_DEST));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("setupPropagationNodePersistence unsubscribe stops further persistence", async () => {
  const rns = makeFakeRns();
  const unsub = setupPropagationNodePersistence(rns, PROP_NODE);
  unsub();
  announce(rns, hexToBytes(PROP_NODE));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("watchAnnounces is a no-op when no hashes are given", async () => {
  const rns = makeFakeRns();
  watchAnnounces(rns, [], "anything");
  announce(rns, hexToBytes(CREW_DEST));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("deps are restored after the module-level overrides", () => {
  // Sanity guard: nothing here mutated deps, but the pattern is documented.
  assert.deepEqual(Object.keys(deps).sort(), Object.keys(REAL_DEPS).sort());
});
