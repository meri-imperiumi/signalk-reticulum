const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity, toHex } = require("@reticulum/core");
const { LXMRouter } = require("@reticulum/lxmf");
const {
  deps,
  normalizeNodeHash,
  configurePropagationNode,
  syncFromNode,
  submitToEmbeddedNode,
} = require("../plugin/propagation");

const REAL_DEPS = { ...deps };

/** A fake LXMRouter recording propagation client calls. */
class FakeLxmRouter {
  constructor() {
    this.deliveryDest = {
      destinationHash: new Uint8Array(16).fill(7),
    };
    this.propagationNodeCalls = [];
    this.submitted = [];
    this.syncCalls = 0;
  }
  setOutboundPropagationNode(hash) {
    this.propagationNodeCalls.push(hash);
  }
  async submitToPropagationNode(message, identity) {
    this.submitted.push({ message, identity });
    return { transientId: new Uint8Array(16).fill(1), stampCost: 16 };
  }
  async syncFromPropagationNode(identity) {
    this.syncCalls += 1;
    return this.syncResult || { received: 0, duplicates: 0 };
  }
}

/** A fake LXMessage that just records its constructor options. */
class FakeLXMessage {
  constructor(options) {
    this.options = options;
  }
}

// --- normalizeNodeHash ------------------------------------------------------

test("normalizeNodeHash accepts a canonical hash", () => {
  const hash = "0123456789abcdef0123456789abcdef";
  assert.equal(normalizeNodeHash(hash), hash);
});

test("normalizeNodeHash trims, lower-cases and strips dashes/space", () => {
  assert.equal(
    normalizeNodeHash("  0123-4567-89AB-CDEF0123456789abcdef  "),
    "0123456789abcdef0123456789abcdef",
  );
});

test("normalizeNodeHash rejects non-strings, empty and bad-length values", () => {
  assert.equal(normalizeNodeHash(undefined), "");
  assert.equal(normalizeNodeHash(null), "");
  assert.equal(normalizeNodeHash(123), "");
  assert.equal(normalizeNodeHash(""), "");
  assert.equal(normalizeNodeHash("tooshort"), "");
  assert.equal(normalizeNodeHash("0123456789abcdef0123456789abcdeg"), "");
});

// --- configurePropagationNode ----------------------------------------------

test("configurePropagationNode sets the outbound node and logs", () => {
  const router = new FakeLxmRouter();
  const logs = [];
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  const ok = configurePropagationNode(
    router,
    "0123456789abcdef0123456789abcdef",
    (...a) => logs.push(a.join(" ")),
  );

  assert.equal(ok, true);
  assert.equal(router.propagationNodeCalls.length, 1);
  assert.deepEqual(
    router.propagationNodeCalls[0],
    Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
  );
  assert.ok(logs.some((l) => /Configured LXMF propagation node/.test(l)));

  Object.assign(deps, REAL_DEPS);
});

test("configurePropagationNode is a no-op without a router or hash", () => {
  assert.equal(
    configurePropagationNode(null, "0123456789abcdef0123456789abcdef"),
    false,
  );
  assert.equal(configurePropagationNode(new FakeLxmRouter(), ""), false);
});

test("configurePropagationNode logs and returns false when setOutboundPropagationNode throws", () => {
  const router = new FakeLxmRouter();
  router.setOutboundPropagationNode = () => {
    throw new Error("nope");
  };
  const logs = [];
  const ok = configurePropagationNode(
    router,
    "0123456789abcdef0123456789abcdef",
    (...a) => logs.push(a.join(" ")),
  );
  assert.equal(ok, false);
  assert.ok(logs.some((l) => /Failed to configure propagation node/.test(l)));
});

// --- syncFromNode -----------------------------------------------------------

test("syncFromNode logs a receive count when messages arrive", async () => {
  const router = new FakeLxmRouter();
  router.syncResult = { received: 3, duplicates: 1 };
  const logs = [];
  const result = await syncFromNode(router, "IDENTITY", (...a) =>
    logs.push(a.join(" ")),
  );
  assert.equal(router.syncCalls, 1);
  assert.deepEqual(result, { received: 3, duplicates: 1 });
  assert.ok(logs.some((l) => /received 3 message/.test(l)));
  assert.ok(logs.some((l) => /1 duplicate/.test(l)));
});

test("syncFromNode stays quiet when nothing new arrived", async () => {
  const router = new FakeLxmRouter();
  router.syncResult = { received: 0, duplicates: 0 };
  const logs = [];
  await syncFromNode(router, "IDENTITY", (...a) => logs.push(a.join(" ")));
  assert.equal(logs.length, 0, "no log line for an empty sync");
});

test("syncFromNode logs and returns zeros when the sync throws", async () => {
  const router = new FakeLxmRouter();
  router.syncFromPropagationNode = async () => {
    throw new Error("node unreachable");
  };
  const logs = [];
  const result = await syncFromNode(router, "IDENTITY", (...a) =>
    logs.push(a.join(" ")),
  );
  assert.deepEqual(result, { received: 0, duplicates: 0 });
  assert.ok(logs.some((l) => /propagation sync failed/.test(l)));
});

// --- embedded propagation node (real in-process LXMRouter) -----------------
//
// When the plugin runs its own propagation node, the node and its client
// share one Reticulum instance and identity, so the link-based
// `submitToPropagationNode` can't reach the local `lxmf.propagation`
// destination (same loopback gap the embedded RFed fix addresses). These
// smoketests exercise the in-process submit/deliver against a REAL LXMRouter
// + PropagationNode — no fakes — to prove the embedded node stores messages
// for remote recipients (store-and-forward) and auto-delivers messages
// addressed to itself, exactly as a remote submitter's link would.

/** Builds a real in-process LXMRouter with an embedded propagation node. */
async function makeEmbeddedRouter({ stampCost = 0 } = {}) {
  const rns = new Reticulum({ requireDestinationProof: false });
  const identity = await Identity.generate();
  const router = new LXMRouter(identity, rns);
  await router.init();
  const node = await router.enablePropagation({ stampCost });
  await router.announcePropagationNode();
  return { rns, identity, router, node };
}

/** Derives the `lxmf.delivery` hash for a given identity (recipient address). */
async function deliveryHashFor(identity) {
  const { Destination, DestType } = require("@reticulum/core");
  const dest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    null,
  );
  return dest.destinationHash;
}

/**
 * Seeds the transport identity cache for a recipient so
 * `_packForPropagationSubmit`
 * (which recalls the recipient identity to encrypt to it) succeeds in a test
 * where the recipient has never announced over the mesh.
 */
async function rememberRecipient(rns, identity, deliveryHash) {
  const pub = await identity.getPublicKey();
  await rns.transport.rememberIdentity(deliveryHash, deliveryHash, pub, null);
}

test("submitToEmbeddedNode stores a message addressed to a remote recipient", async () => {
  const { rns, identity, router, node } = await makeEmbeddedRouter();
  try {
    // A second identity plays the remote recipient.
    const recipient = await Identity.generate();
    const recipientHash = await deliveryHashFor(recipient);
    await rememberRecipient(rns, recipient, recipientHash);

    const { LXMessage } = require("@reticulum/lxmf");
    const message = new LXMessage({
      sourceHash: router.deliveryDest.destinationHash,
      destinationHash: recipientHash,
      title: "Bilge alarm",
      content: "Water rising!",
    });

    assert.equal(node.store.size, 0);
    const result = await submitToEmbeddedNode(router, node, message, identity);
    // The message is stored (not locally delivered — it's for a remote
    // recipient), so the store grew by one.
    assert.equal(node.store.size, 1);
    assert.ok(result.transientId instanceof Uint8Array);
    assert.ok(result.transientId.length > 0);
  } finally {
    await rns.stop();
  }
});

test("submitToEmbeddedNode auto-delivers a message addressed to this node", async () => {
  const { rns, identity, router, node } = await makeEmbeddedRouter();
  try {
    const received = [];
    router.addEventListener("message", (event) => {
      received.push(event.detail.message);
    });

    const { LXMessage } = require("@reticulum/lxmf");
    const message = new LXMessage({
      sourceHash: router.deliveryDest.destinationHash,
      destinationHash: router.deliveryDest.destinationHash,
      title: "Self test",
      content: "hello me",
    });

    // The node's `onLocalDelivery` auto-delivers messages addressed to this
    // node's own delivery hash — they are NOT stored.
    assert.equal(node.store.size, 0);
    // Seed our own delivery identity so _packForPropagationSubmit can recall it.
    await rememberRecipient(rns, identity, router.deliveryDest.destinationHash);
    await submitToEmbeddedNode(router, node, message, identity);
    assert.equal(node.store.size, 0, "not stored — auto-delivered");
    assert.equal(received.length, 1, "message dispatched via event");
    assert.equal(received[0].content, "hello me");
  } finally {
    await rns.stop();
  }
});
