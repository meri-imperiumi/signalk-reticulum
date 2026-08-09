const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deps,
  setupEmbeddedPropagationNode,
  setupEmbeddedRFedNode,
} = require("../plugin/embedded-nodes");

const REAL_DEPS = { ...deps };

// --- setupEmbeddedPropagationNode -------------------------------------------

test("setupEmbeddedPropagationNode skips when disabled in config", async () => {
  const result = await setupEmbeddedPropagationNode({
    lxmf: null,
    identity: {},
    config: { embedded_nodes: { propagation: { enabled: false } } },
    dataDir: null,
    log: () => {},
  });
  assert.equal(result.node, null);
  assert.strictEqual(typeof result.teardown, "function");
});

test("setupEmbeddedPropagationNode skips when LXMF router not available", async () => {
  const result = await setupEmbeddedPropagationNode({
    lxmf: null,
    identity: {},
    config: {},
    dataDir: null,
    log: () => {},
  });
  assert.equal(result.node, null);
});

test("setupEmbeddedPropagationNode skips when storage modules not available", async () => {
  // Mock storage modules as null
  deps.loadLXMFStore = null;
  deps.saveLXMFStore = null;

  const result = await setupEmbeddedPropagationNode({
    lxmf: {},
    identity: {},
    config: { embedded_nodes: { propagation: { enabled: true } } },
    dataDir: null,
    log: () => {},
  });

  assert.equal(result.node, null);

  // Restore
  Object.assign(deps, REAL_DEPS);
});

// --- setupEmbeddedRFedNode -----------------------------------------------

test("setupEmbeddedRFedNode skips when disabled in config", async () => {
  const result = await setupEmbeddedRFedNode({
    rns: null,
    identity: {},
    config: { embedded_nodes: { rfed: { enabled: false } } },
    dataDir: null,
    log: () => {},
  });
  assert.equal(result.node, null);
  assert.strictEqual(typeof result.teardown, "function");
});

test("setupEmbeddedRFedNode skips when storage modules not available", async () => {
  // Mock storage modules as null
  deps.loadRFedStores = null;
  deps.saveRFedStores = null;

  const result = await setupEmbeddedRFedNode({
    rns: {},
    identity: {},
    config: { embedded_nodes: { rfed: { enabled: true } } },
    dataDir: null,
    log: () => {},
  });

  assert.equal(result.node, null);

  // Restore
  Object.assign(deps, REAL_DEPS);
});

// --- Configuration defaults ------------------------------------------------

test("embedded propagation enabled by default when config missing", async () => {
  // With storage modules mocked, it will fail, but we can check the behavior
  const logs = [];
  deps.loadLXMFStore = async () => ({ size: 0 });
  deps.saveLXMFStore = async () => {};

  const lxmf = {
    enablePropagation: async () => ({ store: { size: 0 } }),
    enableAutopeer: () => {},
    announcePropagationNode: async () => {},
  };

  const result = await setupEmbeddedPropagationNode({
    lxmf,
    identity: {},
    config: {}, // No embedded_nodes config
    dataDir: null,
    log: (msg) => logs.push(msg),
  });

  // Should attempt to start (will fail due to other issues, but enabled check passes)
  assert.ok(logs.some((l) => l.includes("propagation")));
});

test("embedded RFed enabled by default when config missing", async () => {
  const logs = [];
  deps.loadRFedStores = async () => ({
    blobStore: { allMessageIds: () => [] },
    subscriptions: [],
    deferred: { totalLen: () => 0 },
    notify: { count: 0 },
  });
  deps.saveRFedStores = async () => {};

  const rns = {};
  const identity = {};

  const result = await setupEmbeddedRFedNode({
    rns,
    identity,
    config: {}, // No embedded_nodes config
    dataDir: null,
    log: (msg) => logs.push(msg),
  });

  // Should attempt to start (will fail due to RFedNode not being available)
  assert.ok(logs.some((l) => l.includes("RFed")));
});

// --- teardown is always callable -----------------------------------------

test("setupEmbeddedPropagationNode teardown is always callable", async () => {
  const result = await setupEmbeddedPropagationNode({
    lxmf: null,
    identity: {},
    config: {},
    dataDir: null,
    log: () => {},
  });
  assert.strictEqual(typeof result.teardown, "function");
  assert.doesNotThrow(() => result.teardown());
});

test("setupEmbeddedRFedNode teardown is always callable", async () => {
  const result = await setupEmbeddedRFedNode({
    rns: null,
    identity: {},
    config: {},
    dataDir: null,
    log: () => {},
  });
  assert.strictEqual(typeof result.teardown, "function");
  assert.doesNotThrow(() => result.teardown());
});
