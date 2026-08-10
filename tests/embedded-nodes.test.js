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

// --- periodic re-announce --------------------------------------------------

test("setupEmbeddedPropagationNode re-announces lxmf.propagation on the interval and stops on teardown", async () => {
  deps.loadLXMFStore = async () => ({ size: 0 });
  deps.saveLXMFStore = async () => {};
  const announceCalls = [];
  const lxmf = {
    enablePropagation: async () => ({ store: { size: 0 } }),
    enableAutopeer: () => {},
    announcePropagationNode: async () => {
      announceCalls.push(Date.now());
    },
  };
  try {
    const result = await setupEmbeddedPropagationNode({
      lxmf,
      identity: {},
      config: {},
      dataDir: null,
      announceIntervalMs: 5,
      log: () => {},
    });
    // One announce fired at start (the explicit announcePropagationNode).
    assert.equal(announceCalls.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 18));
    assert.ok(
      announceCalls.length >= 3,
      "propagation re-announced on interval",
    );
    const countAtTeardown = announceCalls.length;
    result.teardown();
    await new Promise((resolve) => setTimeout(resolve, 18));
    assert.equal(
      announceCalls.length,
      countAtTeardown,
      "no more re-announces after teardown",
    );
  } finally {
    Object.assign(deps, REAL_DEPS);
  }
});

test("setupEmbeddedPropagationNode re-announces nothing when announceIntervalMs is 0", async () => {
  deps.loadLXMFStore = async () => ({ size: 0 });
  deps.saveLXMFStore = async () => {};
  const announceCalls = [];
  const lxmf = {
    enablePropagation: async () => ({ store: { size: 0 } }),
    enableAutopeer: () => {},
    announcePropagationNode: async () => {
      announceCalls.push(Date.now());
    },
  };
  try {
    const result = await setupEmbeddedPropagationNode({
      lxmf,
      identity: {},
      config: {},
      dataDir: null,
      announceIntervalMs: 0,
      log: () => {},
    });
    assert.equal(announceCalls.length, 1, "only the start announce");
    await new Promise((resolve) => setTimeout(resolve, 18));
    assert.equal(announceCalls.length, 1, "no periodic re-announce");
    result.teardown();
  } finally {
    Object.assign(deps, REAL_DEPS);
  }
});

test("setupEmbeddedPropagationNode teardown clears the initial peer-sync timer without throwing (regression)", async () => {
  // Peers configured used to declare `const _initialSync` (block-scoped)
  // then reference the undeclared `initialSync` in teardown → ReferenceError,
  // so the sync timer was never cleared and the final store persist was
  // skipped. Verify teardown now runs cleanly with peers configured.
  deps.loadLXMFStore = async () => ({ size: 0 });
  deps.saveLXMFStore = async () => {};
  const lxmf = {
    enablePropagation: async () => ({ store: { size: 0 } }),
    enableAutopeer: () => {},
    announcePropagationNode: async () => {},
    syncPeers: async () => {},
  };
  try {
    const result = await setupEmbeddedPropagationNode({
      lxmf,
      identity: {},
      config: {
        embedded_nodes: {
          propagation: {
            enabled: true,
            peers: ["ab".repeat(16)],
          },
        },
      },
      dataDir: null,
      announceIntervalMs: 0,
      log: () => {},
    });
    assert.ok(result.node, "propagation node started");
    assert.doesNotThrow(() => result.teardown());
  } finally {
    Object.assign(deps, REAL_DEPS);
  }
});

test("setupEmbeddedRFedNode re-announces the node on the interval and stops on teardown", async () => {
  deps.loadRFedStores = async () => ({
    blobStore: { allMessageIds: () => [] },
    subscriptions: [],
    deferred: { totalLen: () => 0 },
    notify: { count: 0 },
  });
  deps.saveRFedStores = async () => {};
  const announceCalls = [];
  /** A fake RFedNode that records announce() and start(). */
  class FakeRFedNode {
    constructor() {
      this.blobStore = { allMessageIds: () => [] };
      this.subscriptions = { length: 0 };
      this.deferred = { totalLen: () => 0 };
      this.notifyRegistry = { count: 0 };
    }
    async start() {
      await this.announce();
    }
    announce() {
      announceCalls.push(Date.now());
      return Promise.resolve();
    }
    tickMaintenance() {
      return { blobsEvicted: 0, deferredEvicted: 0 };
    }
    stop() {}
  }
  const realNode = deps.RFedNode;
  deps.RFedNode = FakeRFedNode;
  try {
    const result = await setupEmbeddedRFedNode({
      rns: {},
      identity: {},
      config: { embedded_nodes: { rfed: { enabled: true } } },
      dataDir: null,
      announceIntervalMs: 5,
      log: () => {},
    });
    // One announce fired at start (RFedNode.start() → announce()).
    assert.equal(announceCalls.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 18));
    assert.ok(announceCalls.length >= 3, "rfed node re-announced on interval");
    const countAtTeardown = announceCalls.length;
    result.teardown();
    await new Promise((resolve) => setTimeout(resolve, 18));
    assert.equal(
      announceCalls.length,
      countAtTeardown,
      "no more re-announces after teardown",
    );
  } finally {
    deps.RFedNode = realNode;
    Object.assign(deps, REAL_DEPS);
  }
});
