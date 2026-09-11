const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity, toHex } = require("@reticulum/core");
const { LXMRouter } = require("@reticulum/core/src/lxmf/index.js");
const { PacketReceipt } = require("@reticulum/core/src/core/packet_receipt.js");
const { setupMessaging, makeDeliverer } = require("../plugin/messaging");
const {
  makeAutoDeliverer,
  makeEmbeddedPropagationDeliverer,
} = require("../plugin/propagation");

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
 * Real-integration smoketest for the "outbound LXMF dies after a while"
 * failure mode: the plugin has a stale-but-present path to a peer that has
 * since become unreachable, and its reply must not vanish silently.
 *
 * Reproduces the reported scenario end-to-end against the real
 * @reticulum/core transport (with the path-recovery / proof-aware delivery
 * fixes): a client announces, the plugin learns its route, then the client
 * goes dark. A reply through the plugin's outbound deliverer (direct-first,
 * embedded-propagation fallback) must
 *
 *   1. attempt direct delivery (DIRECT link, then opportunistic),
 *   2. observe the failure (no link handshake, no delivery proof), and
 *   3. store the message on the embedded propagation node for the client
 *      instead of reporting success while the mesh dropped everything.
 *
 * The proof-wait (~6 s) and link-establishment (~10 s) timeouts make this a
 * slow test by necessity — they are exactly the windows after which the
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

const makeNode = (iface) => {
  const rns = new Reticulum({ storageAdapter: null, logLevel: "error" });
  rns.transport.addInterface(iface, true);
  rns.transport.defaultInterface = iface;
  return rns;
};

/** Waits until `fn` returns truthy (timeout rejects). */
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
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
    // exactly like plugin/index.js wires deliverOutbound (direct-first,
    // embedded store-and-forward fallback).
    const lxmA = await setupMessaging(rnsA, idA, { displayName: "Plugin" });
    const propNode = await lxmA.enablePropagation({ stampCost: 0 });
    const logs = [];
    const debug = (msg) => logs.push(msg);
    const deliverOutbound = makeAutoDeliverer({
      directDeliver: makeDeliverer(lxmA, idA, debug),
      propagationDeliver: makeEmbeddedPropagationDeliverer(
        lxmA,
        propNode,
        idA,
        debug,
      ),
      hasPath: rnsA.transport.hasPath.bind(rnsA.transport),
      fromHex: (hex) => Buffer.from(hex, "hex"),
      debug,
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
      logs.some((l) => /Direct delivery.*failed.*falling back/.test(l)),
      `failure fallback logged: ${logs.join(" | ")}`,
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
