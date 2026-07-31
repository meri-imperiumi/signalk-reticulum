const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity, Destination, toHex } = require("@reticulum/core");
const { setupMessaging, makeDeliverer } = require("../plugin/messaging");
const commands = require("../plugin/commands");

/**
 * Regression guard for the "no PROOF / no response" bug.
 *
 * Peers (NomadNet / Sideband) learn our ratchet public key from the
 * lxmf.delivery announce and encrypt opportunistic inbound messages to it. If
 * the destination holds no matching ratchet private key, `Identity.decrypt()`
 * returns null, no PROOF is emitted, and the sender retransmits forever with no
 * acknowledgement — exactly what was observed against NomadNet while outbound
 * telemetry still worked. setupMessaging must therefore keep the ratchets that
 * `LXMRouter.init()` enables (the LXMF echobot configuration).
 *
 * This drives the real @reticulum/core stack over an in-memory bridge and
 * asserts both that the destination holds a ratchet and that a real
 * opportunistic round-trip (encrypted to that ratchet) decrypts and is
 * answered.
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

test("setupMessaging keeps a ratchet and an opportunistic inbound message decrypts and is answered", async () => {
  const { a: ifA, b: ifB } = makeBridge("plug-iface", "client-iface");
  const rnsA = makeNode(ifA);
  const rnsB = makeNode(ifB);
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  try {
    // Plugin node A — setupMessaging must leave the init() ratchet in place.
    const lxmA = await setupMessaging(rnsA, idA, { displayName: "Plugin" });
    assert.equal(
      lxmA.deliveryDest.ratchetsEnabled,
      true,
      "delivery destination keeps ratchets enabled",
    );
    assert.ok(
      Array.isArray(lxmA.deliveryDest.ratchets) &&
        lxmA.deliveryDest.ratchets.length > 0,
      "delivery destination holds a ratchet private key",
    );

    const deliverA = makeDeliverer(lxmA, idA);
    lxmA.addEventListener("message", (ev) => {
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

    // Client node B (also ratcheted) announces so A can reply.
    const lxmB = await setupMessaging(rnsB, idB, { displayName: "Client" });
    let clientPong = null;
    lxmB.addEventListener("message", (ev) => {
      clientPong = ev.detail.message.content;
    });

    await new Promise((r) => setTimeout(r, 50));

    // B must have learned A's ratchet from the announce — the exact key A
    // holds, so the opportunistic packet B encrypts is one A can decrypt.
    const learned = Destination.recallRatchet(
      lxmA.deliveryDest.destinationHash,
    );
    assert.ok(
      learned && learned.length > 0,
      "client learned the plugin's ratchet from the announce",
    );

    const deliverB = makeDeliverer(lxmB, idB);
    await deliverB(toHex(lxmA.deliveryDest.destinationHash), "", "ping");

    await waitFor(() => clientPong === "Pong");
    assert.equal(
      clientPong,
      "Pong",
      "ratchet-encrypted inbound message decrypted, proven, and answered",
    );
  } finally {
    await rnsA.stop();
    await rnsB.stop();
  }
});
