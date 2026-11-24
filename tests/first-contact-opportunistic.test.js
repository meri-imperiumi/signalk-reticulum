const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity, toHex } = require("@reticulum/core");
const { disableReticulumStamps } = require("./helpers/reticulum-stamps.js");
const { setupMessaging, makeDeliverer } = require("../plugin/messaging");
const commands = require("../plugin/commands");

disableReticulumStamps();

/**
 * TRUE first-contact opportunistic: the client sends a ping WITHOUT having
 * announced first, so the plugin has never heard the client's identity. This
 * mirrors a mobile app that fires off a single opportunistic message. The
 * plugin must request the sender's path, learn the identity from the
 * path-response announce, re-process the parked message, and reply.
 *
 * Unlike pingpong.test.js (which pre-announces the client), this exercises the
 * park → path-request → announce → re-process → reply cycle that an
 * opportunistic mobile client depends on.
 */

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

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

test("first-contact opportunistic ping (client did NOT pre-announce) is still answered", async () => {
  const { a: ifA, b: ifB } = makeBridge("plug-iface", "client-iface");
  const rnsA = makeNode(ifA);
  const rnsB = makeNode(ifB);
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  try {
    // Plugin A announces so the client can address it.
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

    // Client B: bring up a router but DO NOT announce (no displayName), so A
    // has never heard B's identity — the true first-contact case.
    const lxmB = await setupMessaging(rnsB, idB, {});
    let clientPong = null;
    lxmB.addEventListener("message", (ev) => {
      clientPong = ev.detail.message.content;
    });

    // Let A's announce reach B so B can address it.
    await new Promise((r) => setTimeout(r, 30));

    // B sends a single opportunistic ping (no link).
    const deliverB = makeDeliverer(lxmB, idB);
    await deliverB(toHex(lxmA.deliveryDest.destinationHash), "", "ping");

    await waitFor(() => pluginSawPing);
    await waitFor(() => clientPong === "Pong", 3000);

    assert.equal(
      pluginSawPing,
      true,
      "plugin dispatched the first-contact ping",
    );
    assert.equal(clientPong, "Pong", "client received the pong");
  } finally {
    await rnsA.stop();
    await rnsB.stop();
  }
});
