const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity, toHex } = require("@reticulum/core");
const { disableReticulumStamps } = require("./helpers/reticulum-stamps.js");
const { setupMessaging, makeDeliverer } = require("../plugin/messaging");

disableReticulumStamps();
const commands = require("../plugin/commands");

/**
 * End-to-end ping/pong over an in-memory two-node mesh.
 *
 * Exercises the first-contact path that used to silently fail: a client sends
 * a "ping" to the plugin *before* the plugin has learned the client's identity
 * (no prior announce). The plugin must request the sender's path, learn the
 * identity from the path-response announce, re-process the parked message, and
 * reply "Pong" — otherwise the client sees a delivery proof but no response.
 *
 * This relies on the @reticulum/core LXMRouter actually requesting the path
 * and re-processing parked messages on announce; with an older library the
 * plugin would never dispatch the message.
 */

/** Two in-memory interfaces bridged full-duplex: a packet written to one is
 * delivered as an inbound "packet" event on the other. */
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

/** Polls `fn` until it returns truthy, resolving with that value (timeout
 * rejects). Used because the multi-hop path-request → announce → re-process
 * flow is async even though the bridge is synchronous. */
async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

test("ping/pong works on first contact before the sender has announced", async () => {
  const { a: ifA, b: ifB } = makeBridge("plug-iface", "client-iface");
  const rnsA = makeNode(ifA);
  const rnsB = makeNode(ifB);
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  try {
    // Plugin node A: bring up LXMF and reply to commands (ping → Pong).
    const lxmA = await setupMessaging(rnsA, idA, { displayName: "Plugin" });
    const deliverA = makeDeliverer(lxmA, idA);
    let pluginSawPing = false;
    lxmA.addEventListener("message", (ev) => {
      pluginSawPing = ev.detail.message.content === "ping";
      commands
        .handleMessage(
          ev.detail.message,
          { crew: [] },
          deliverA,
          { debug() {}, error() {} },
          ev.detail.link,
        )
        .catch(() => {});
    });

    // Client node B: initialise a router but DO NOT announce, so A has never
    // heard B's identity (the first-contact case).
    const lxmB = await setupMessaging(rnsB, idB, { displayName: "Client" });
    let clientPong = null;
    lxmB.addEventListener("message", (ev) => {
      clientPong = ev.detail.message.content;
    });

    const aHash = toHex(lxmA.deliveryDest.destinationHash);
    const deliverB = makeDeliverer(lxmB, idB);

    // Let A's announce reach B through the bridge so B can address it, then
    // send the ping. (The bridge is synchronous, so a brief wait is plenty.)
    await new Promise((r) => setTimeout(r, 30));

    await deliverB(aHash, "", "ping");

    // A must dispatch the ping (after requesting B's path + re-processing)…
    await waitFor(() => pluginSawPing);
    // …and reply "Pong", which B must receive.
    await waitFor(() => clientPong === "Pong");

    assert.equal(
      pluginSawPing,
      true,
      "plugin dispatched the first-contact ping",
    );
    assert.equal(clientPong, "Pong", "client received the pong reply");
  } finally {
    await rnsA.stop();
    await rnsB.stop();
  }
});
