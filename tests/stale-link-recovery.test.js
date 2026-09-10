const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity, toHex } = require("@reticulum/core");
const { LXMRouter, LXMessage } = require("@reticulum/core/src/lxmf/index.js");
const {
  LinkStatus,
  LinkTeardownReason,
} = require("@reticulum/core/src/transport/link.js");
const { setupMessaging } = require("../plugin/messaging");

/**
 * Real-integration regression smoketest for the "zombie link" failure mode
 * behind "LXMF messages don't arrive after a while, until Signal K is
 * restarted".
 *
 * The failure: reticulum-js's link watchdog refreshed the link's liveness
 * clock when *sending* a keepalive ping, so an initiator-side link whose peer
 * had vanished without a LINKCLOSE (the crew going ashore, a connection gap,
 * an rnsd restart) stayed ACTIVE forever. Every subsequent outbound send
 * reused the cached dead link (`LXMRouter._establishDirectLink` only evicts
 * non-ACTIVE entries), encrypted the message to the dead link session, and
 * reported success — the message silently vanished. The Python reference
 * counts only *inbound* traffic toward liveness (`last_inbound`), so a dead
 * link tears down after `stale_time` and the next send establishes a fresh
 * one.
 *
 * Reproduction (real @reticulum/core over an in-memory bridge):
 *
 *   1. the plugin node and a peer exchange announces; the peer's first send
 *      establishes (and caches) a DIRECT link — the baseline message arrives
 *   2. the peer goes dark with no teardown; the link's cadence is shrunk so
 *      the 1 s watchdog tick exercises a full keepalive/stale cycle
 *   3. the dead link must tear down (TIMEOUT) despite keepalive pings being
 *      written into the void, and be evicted from the router's link cache
 *   4. the peer returns; the next send must establish a *fresh* link and the
 *      message must arrive at the plugin node
 *
 * The suite self-skips against an unfixed @reticulum/core (no
 * `lastKeepaliveTime` on the link — the field the fix adds to gate ping
 * cadence without touching liveness), the same release-gate pattern as the
 * 0.5.0 reconnect smoketest.
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

test("a send after the peer returns establishes a fresh link instead of riding the dead one", async (t) => {
  const { a: ifA, b: ifB } = makeBridge("plug-iface", "peer-iface");
  const rnsA = makeNode(ifA);
  const rnsB = makeNode(ifB);
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  try {
    // Plugin node A, wired like plugin/index.js wires messaging.
    const lxmA = await setupMessaging(rnsA, idA, { displayName: "Plugin" });

    // Peer node B (a returning crew device).
    const lxmB = new LXMRouter(idB, rnsB);
    await lxmB.init();
    await lxmB.announce("Peer");
    const aHash = lxmA.deliveryDest.destinationHash;
    await waitFor(() => rnsB.transport.hasPath(aHash));

    /** @type {string[]} */
    const received = [];
    lxmA.addEventListener("message", (e) => {
      received.push(e.detail.message.content);
    });

    const sendToA = (content) =>
      lxmB.send(
        new LXMessage({
          sourceHash: lxmB.deliveryDest.destinationHash,
          destinationHash: aHash,
          title: "",
          content,
        }),
        idB,
      );

    // 1. Baseline: the send establishes a DIRECT link and the message arrives.
    await sendToA("baseline");
    await waitFor(() => received.includes("baseline"));
    assert.equal(lxmB.directLinks.size, 1, "peer cached the DIRECT link");
    const cached = [...lxmB.directLinks.values()][0];

    // Release gate: the zombie-link watchdog fix adds `lastKeepaliveTime`
    // (Python `last_keepalive`) to gate ping cadence without refreshing
    // liveness. Without it, the dead link below never tears down and the
    // post-gap send vanishes — skip instead of failing against an unfixed
    // dependency.
    if (!("lastKeepaliveTime" in cached)) {
      t.skip(
        "installed @reticulum/core still resets link liveness on its own " +
          "keepalive sends (zombie links); update the dependency before " +
          "releasing (see CHANGELOG)",
      );
      return;
    }

    // 2. The peer goes dark with no teardown. Shrink the cadence so the 1 s
    //    watchdog tick sees a full keepalive/stale cycle (the STALE_FACTOR
    //    relation is preserved: stale = 2 × keepalive).
    ifA.peer = null;
    ifB.peer = null;
    cached.keepaliveInterval = 0.3;
    cached.staleTime = 0.6;

    // 3. The dead link must tear down despite keepalive pings being written,
    //    and the router must evict it from its link cache.
    await waitFor(() => cached.status === LinkStatus.CLOSED, 4000);
    assert.equal(
      cached.teardownReason,
      LinkTeardownReason.TIMEOUT,
      "the dead link tore down with TIMEOUT",
    );
    await waitFor(() => lxmB.directLinks.size === 0, 2000);

    // 4. The peer returns; the next send must ride a *fresh* link and arrive.
    ifA.peer = ifB;
    ifB.peer = ifA;
    await sendToA("post-gap");
    await waitFor(() => received.includes("post-gap"), 10000);
    assert.ok(
      received.includes("post-gap"),
      "the post-gap message arrived over a fresh link",
    );
    assert.equal(lxmB.directLinks.size, 1, "a fresh link was cached");
    assert.notEqual(
      [...lxmB.directLinks.values()][0],
      cached,
      "the cached link is a new one, not the zombie",
    );
  } finally {
    await rnsA.stop();
    await rnsB.stop();
  }
});
