const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity, toHex } = require("@reticulum/core");
const { LXMRouter } = require("@reticulum/lxmf");
const { PacketReceipt } = require("@reticulum/core/src/core/packet_receipt.js");
const { setupMessaging, makeDeliverer } = require("../plugin/messaging");
const { configurePropagationNode } = require("../plugin/propagation");

/**
 * Probes whether the installed @reticulum/core settles opportunistic LXMF
 * delivery on the recipient's PROOF (`PacketReceipt.whenSettled` + the
 * router awaiting it) — the upstream path-recovery fix this smoketest
 * depends on. Without it, a failed direct send resolves "successfully" at
 * framer-write time and the propagation fallback never triggers, which is
 * exactly the regression under test, so the suite self-skips instead of
 * failing against an unfixed dependency (same release-gate pattern as the
 * 0.5.0 reconnect smoketest).
 *
 * @returns {boolean} `true` when the core exposes delivery settlement.
 */
function coreSettlesOpportunisticDelivery() {
  return typeof PacketReceipt?.prototype?.whenSettled === "function";
}

/**
 * Real-integration smoketests for the "outbound LXMF dies after a while"
 * failure mode: the plugin has a stale-but-present path to a peer that has
 * since become unreachable, and its reply must not vanish silently — it must
 * reach a propagation node (store-and-forward), for both propagation modes
 * the plugin supports:
 *
 *   1. **Embedded** — the in-plugin propagation node: the outbound deliverer
 *      submits to it in-process (the link-based submit cannot reach a local
 *      destination).
 *   2. **External** — a separate LXMRouter running `lxmf.propagation` on the
 *      mesh: the router's own escalation ladder
 *      (`LXMRouter.send(..., { fallback: "propagation" })`) submits the
 *      message to it over a Link Resource, exactly like Sideband would.
 *
 * Both tests reproduce the field scenario end-to-end against the real
 * @reticulum/core transport (with the path-recovery / proof-aware delivery
 * fixes): a client announces, the plugin learns its route, then the client
 * goes dark. A reply through the plugin's outbound deliverer must
 *
 *   1. attempt direct delivery (DIRECT link, then opportunistic),
 *   2. observe the failure (no link handshake, no delivery proof), and
 *   3. store the message on the propagation node for the client instead of
 *      reporting success while the mesh dropped everything.
 *
 * The proof-wait (~6 s) and link-establishment (~10 s) timeouts make these
 * slow tests by necessity — they are exactly the windows after which the
 * reference implementation gives up on direct delivery.
 */

/** Two in-memory interfaces bridged full-duplex (see pingpong.test.js). */
function makeBridge(nameA, nameB) {
  class BridgeIface extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      this.online = true;
      this.bitrate = 62500;
      this.peer = null;
      const self = this;
      this._packetWriter = {
        write(packet) {
          if (self.peer) {
            self.peer.dispatchEvent(
              new CustomEvent("packet", { detail: { packet } }),
            );
          }
          return Promise.resolve();
        },
      };
    }
    async connect() {}
    async disconnect() {}
  }
  const a = new BridgeIface(nameA);
  const b = new BridgeIface(nameB);
  a.peer = b;
  b.peer = a;
  return { a, b };
}

const makeNode = (...ifaces) => {
  const rns = new Reticulum({ storageAdapter: null, logLevel: "error" });
  for (const iface of ifaces) {
    rns.transport.addInterface(iface, true);
  }
  rns.transport.defaultInterface = ifaces[0];
  return rns;
};

/** Waits until `fn` returns truthy (timeout rejects). */
async function waitFor(fn, timeoutMs = 5000, message = "waitFor timed out") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(message);
}

test("a reply to an unreachable peer falls back to the embedded propagation node", async (t) => {
  if (!coreSettlesOpportunisticDelivery()) {
    t.skip(
      "installed @reticulum/core does not settle opportunistic delivery on " +
        "the recipient's proof yet; update the dependency before releasing " +
        "(see CHANGELOG)",
    );
    return;
  }
  const { a: ifA, b: ifB } = makeBridge("plug-iface", "client-iface");
  const rnsA = makeNode(ifA);
  const rnsB = makeNode(ifB);
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  try {
    // Plugin node A: LXMF router with an embedded propagation node, wired
    // exactly like plugin/index.js wires the outbound deliverer (the sender
    // escalates through the router's ladder and submits to the embedded node
    // in-process when direct delivery fails).
    const lxmA = await setupMessaging(rnsA, idA, { displayName: "Plugin" });
    const propNode = await lxmA.enablePropagation({ stampCost: 0 });
    const logs = [];
    const debug = (msg) => logs.push(msg);
    const deliverOutbound = makeDeliverer(lxmA, idA, {
      debug,
      getEmbeddedNode: () => propNode,
    });

    // Client node B announces, so A learns its identity, ratchet and route.
    const lxmB = new LXMRouter(idB, rnsB);
    await lxmB.init();
    await lxmB.announce("Client");
    const bHash = toHex(lxmB.deliveryDest.destinationHash);
    await waitFor(() =>
      rnsA.transport.hasPath(lxmB.deliveryDest.destinationHash),
    );
    assert.equal(propNode.store.size, 0, "nothing stored initially");

    // The client goes dark: A's writes now reach nobody (the peer side of the
    // bridge is severed), but A's route table entry — the stale-but-present
    // path — remains, exactly like the field failure.
    ifA.peer = null;

    // Monotonic clock: a wall-clock jump mid-test (an NTP/NITZ sync on the
    // host) once read a 19 s run as 77 s and tripped the bound below.
    const started = process.hrtime.bigint();
    await deliverOutbound(bHash, "", "Pong");
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    // The reply was stored for the client instead of vanishing.
    assert.equal(
      propNode.store.size,
      1,
      "the failed direct reply must land on the propagation node",
    );
    assert.ok(
      logs.some((l) => /embedded propagation node/.test(l)),
      `in-process submit logged: ${logs.join(" | ")}`,
    );
    // Direct delivery was genuinely attempted before giving up: the
    // link-establishment wait alone is ~10 s (and must not be a 120 s hang).
    assert.ok(
      elapsed > 5_000 && elapsed < 60_000,
      `delivery settled in ${elapsed} ms (attempted direct, then fell back)`,
    );

    // The store entry is addressed to the client's lxmf.delivery destination,
    // encrypted for them — what their router will pull on the next sync.
    const entry = [...propNode.store._entries.values()][0];
    assert.equal(
      toHex(entry.destinationHash),
      bHash,
      "stored message addressed to the client",
    );
  } finally {
    await rnsA.stop();
    await rnsB.stop();
  }
});

test("a reply to an unreachable peer is submitted to the external propagation node over the mesh", async (t) => {
  if (!coreSettlesOpportunisticDelivery()) {
    t.skip(
      "installed @reticulum/core does not settle opportunistic delivery on " +
        "the recipient's proof yet; update the dependency before releasing " +
        "(see CHANGELOG)",
    );
    return;
  }
  // Topology: plugin node A bridges to the propagation node B (stays up) and
  // to the client C (goes dark mid-test).
  const { a: ifAB, b: ifBA } = makeBridge("plug-iface", "propnode-iface");
  const { a: ifAC, b: ifCC } = makeBridge("plug-iface2", "client-iface");
  const rnsA = makeNode(ifAB, ifAC);
  const rnsB = makeNode(ifBA);
  const rnsC = makeNode(ifCC);
  const idA = await Identity.generate();
  const idB = await Identity.generate();
  const idC = await Identity.generate();

  try {
    // Plugin node A: plain LXMF router, no embedded node — store-and-forward
    // goes to the external propagation node instead.
    const lxmA = await setupMessaging(rnsA, idA, { displayName: "Plugin" });
    const logs = [];
    const debug = (msg) => logs.push(msg);

    // Propagation node B: a real lxmf.propagation node on the mesh.
    const lxmB = new LXMRouter(idB, rnsB);
    await lxmB.init();
    const propNodeB = await lxmB.enablePropagation({ stampCost: 0 });
    await lxmB.announcePropagationNode();

    // Client node C announces, so A learns its identity, ratchet and route.
    const lxmC = new LXMRouter(idC, rnsC);
    await lxmC.init();
    await lxmC.announce("Client");
    const cHash = toHex(lxmC.deliveryDest.destinationHash);

    // A learns the client's route and B's propagation destination, then A is
    // pointed at B exactly like the plugin's propagation wiring does.
    await waitFor(() =>
      rnsA.transport.hasPath(lxmC.deliveryDest.destinationHash),
    );
    await waitFor(() =>
      rnsA.transport.hasPath(lxmB.propagationDest.destinationHash),
    );
    assert.equal(
      configurePropagationNode(
        lxmA,
        toHex(lxmB.propagationDest.destinationHash),
        debug,
      ),
      true,
      "external propagation node configured",
    );
    assert.equal(propNodeB.store.size, 0, "nothing stored initially");

    const deliverOutbound = makeDeliverer(lxmA, idA, { debug });

    // The client goes dark; the path A↔B (plugin ↔ propagation node) stays up.
    ifAC.peer = null;

    // Monotonic clock: a wall-clock jump mid-test (an NTP/NITZ sync on the
    // host) once read a 19 s run as 77 s and tripped the bound below.
    const started = process.hrtime.bigint();
    await deliverOutbound(cHash, "", "Pong");
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    // The reply reached the propagation node over the mesh and was stored for
    // the client instead of vanishing.
    // B ingests the submitted Resource asynchronously; wait for the store.
    await waitFor(
      () => propNodeB.store.size > 0,
      10_000,
      "the failed direct reply must be submitted to the external propagation node",
    );
    // Direct delivery was genuinely attempted before giving up: the
    // link-establishment wait alone is ~10 s (and must not be a 120 s hang).
    assert.ok(
      elapsed > 5_000 && elapsed < 60_000,
      `delivery settled in ${elapsed} ms (attempted direct, then propagated)`,
    );

    // The stored message is addressed to the client's lxmf.delivery
    // destination, encrypted for them — what their router will pull on the
    // next sync.
    const entry = [...propNodeB.store._entries.values()][0];
    assert.equal(
      toHex(entry.destinationHash),
      cHash,
      "stored message addressed to the client",
    );
  } finally {
    // Links are application-owned: `rns.stop()` does not tear them down, and
    // an ACTIVE link's keepalives would keep the event loop alive after the
    // test.
    try {
      await lxmA.outboundPropagationLink?.teardown();
      // Give the peer a moment to process the LINKCLOSE before its
      // interfaces go away — otherwise its per-link watchdog interval
      // (not unref'd) keeps ticking forever and the test process hangs.
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      /* best effort */
    }
    await rnsA.stop();
    await rnsB.stop();
    await rnsC.stop();
  }
});
