const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity } = require("@reticulum/core");
const { disableReticulumStamps } = require("./helpers/reticulum-stamps.js");
const { setupMessaging } = require("../plugin/messaging");

disableReticulumStamps();

/**
 * Smoketest that the lxmf.delivery announce advertises a forward-secrecy
 * ratchet, matching the LXMF echobot.
 *
 * Peers (NomadNet / Sideband) learn the ratchet public key from the announce
 * and encrypt opportunistic inbound messages to it; the destination must keep
 * the matching ratchet private key or `Identity.decrypt()` returns null, no
 * PROOF is emitted, and the sender gets no acknowledgement. These tests drive
 * the real `@reticulum/core` stack against a recording interface so the
 * on-wire announce bytes — not a fake — are inspected.
 */

/** Packet type for an Announce (§2.1). */
const ANNOUNCE = 0x01;

/**
 * Builds a real Reticulum node with a single fake interface whose packet
 * writer records every broadcast Packet, so announces can be inspected.
 *
 * @returns {{rns: object, recorded: import("@reticulum/core").Packet[]}}
 */
function makeRns() {
  /** @type {any[]} */
  const recorded = [];
  const iface = {
    name: "recorder",
    online: true,
    bitrate: 62500,
    _packetWriter: {
      write: (packet) => {
        recorded.push(packet);
        return Promise.resolve();
      },
    },
    async connect() {},
    async disconnect() {},
    addEventListener() {},
  };
  const rns = new Reticulum({ storageAdapter: null, logLevel: "error" });
  rns.transport.addInterface(iface, true);
  rns.transport.defaultInterface = iface;
  return { rns, recorded };
}

/**
 * Finds the first Announce packet captured on the recording interface.
 *
 * @param {any[]} recorded
 * @returns {any}
 */
function firstAnnounce(recorded) {
  const announce = recorded.find((p) => p.packetType === ANNOUNCE);
  assert.ok(announce, "an announce packet was broadcast");
  return announce;
}

test("the lxmf.delivery announce advertises a ratchet (context_flag = 1) so peers can encrypt inbound messages", async () => {
  const { rns, recorded } = makeRns();
  const identity = await Identity.generate();

  try {
    await setupMessaging(rns, identity, { displayName: "Boat" }, () => {});
    // Let the async broadcast write settle.
    await new Promise((r) => setTimeout(r, 20));

    const announce = firstAnnounce(recorded);
    assert.equal(
      announce.contextFlag,
      true,
      "ratchet_pub present in the announce body",
    );

    // A ratcheted announce is 184 bytes (pubkey 64 + name_hash 10 +
    // random_hash 10 + ratchet 32 + signature 64 + app_data 4 for "Boat"); a
    // ratchet-less one would be 32 bytes smaller.
    assert.ok(
      announce.payload.length >= 180,
      `announce body is ratchet-sized (${announce.payload.length} bytes)`,
    );

    // And it validates cleanly as an lxmf.delivery announce.
    const valid = await Identity.validateAnnounce(
      announce.destinationHash,
      announce.contextFlag,
      announce.payload,
    );
    assert.ok(valid, "announce validates");
    assert.ok(
      valid.ratchet && valid.ratchet.length === 32,
      "32-byte ratchet parsed",
    );
    assert.ok(valid.appData && valid.appData.length > 0, "app_data present");
  } finally {
    await rns.stop();
  }
});
