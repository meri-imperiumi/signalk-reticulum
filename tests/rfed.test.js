const test = require("node:test");
const assert = require("node:assert/strict");

const { Reticulum, Identity, toHex, fromHex } = require("@reticulum/core");
const {
  RFedNode,
  BlobStore,
  SubscriptionTable,
  DeferredQueue,
  NotifyRegistry,
} = require("@reticulum/core/src/rfed/index.js");
const rfed = require("../plugin/rfed");
const {
  SCHEMA_VERSION,
  DEFAULT_CHANNEL,
  effectiveChannel,
  encodeShipTelemetry,
  decodeShipTelemetry,
  shipTelemetryToValues,
  buildShipTelemetryDelta,
  handleInboundShipTelemetry,
  makeShipTelemetryPublisher,
  makeEmbeddedShipTelemetryPublisher,
  setupRFed,
  setupEmbeddedRFedClient,
} = rfed;
const {
  FIELD_TELEMETRY,
  extractTelemetryField,
} = require("../plugin/telemetry");

/** A representative full readings object used across many tests. */
function fullReadings() {
  return {
    now: 1700000000,
    name: "Meri Imperiumi",
    mmsi: "230001234",
    callsign: "OH1234",
    shipType: 36,
    destination: "HELSINKI",
    draft: 2.1,
    length: 12.5,
    beam: 4.0,
    latitude: 60.175987,
    longitude: -21.094551,
    sog: 5.0,
    cog: 0.5,
    heading: 0.4,
    status: "under way using engine",
    windSpeed: 6.2,
    windDir: 1.5,
    pressure: 101325,
    temp: 293.15,
    humidity: 0.55,
  };
}

/** Builds an RFed onMessage-shaped object from a readings snapshot + sender. */
function makeRfedMessage(readings, senderIdentity, extras = {}) {
  const packed = encodeShipTelemetry(readings);
  return {
    message: {
      timestamp: readings.now + 500,
      fields: { [FIELD_TELEMETRY]: packed },
    },
    senderIdentity,
    sourceHash: fromHex("ab".repeat(16)),
    signatureValid: true,
    ...extras,
  };
}

/** Minimal recording Signal K app stand-in. */
function makeApp() {
  const messages = [];
  const debugs = [];
  const errors = [];
  return {
    app: {
      debug(msg) {
        debugs.push(msg);
      },
      error(msg) {
        errors.push(msg);
      },
      handleMessage(id, delta) {
        messages.push({ id, delta });
      },
    },
    messages,
    debugs,
    errors,
  };
}

// --- constants / channel ----------------------------------------------------

test("defaults: schema version and public default channel", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(DEFAULT_CHANNEL, "public.signalk.vessels");
});

test("effectiveChannel defaults to the public channel for absent/blank input", () => {
  assert.equal(effectiveChannel(undefined), DEFAULT_CHANNEL);
  assert.equal(effectiveChannel(null), DEFAULT_CHANNEL);
  assert.equal(effectiveChannel(123), DEFAULT_CHANNEL);
  assert.equal(effectiveChannel(""), DEFAULT_CHANNEL);
  assert.equal(effectiveChannel("   "), DEFAULT_CHANNEL);
});

test("effectiveChannel trims and keeps a custom (incl. private) channel name", () => {
  assert.equal(effectiveChannel("my.fleet"), "my.fleet");
  assert.equal(effectiveChannel("  deadbeef.private  "), "deadbeef.private");
});

// --- encode / decode --------------------------------------------------------

test("encodeShipTelemetry round-trips a full snapshot through decode", () => {
  const packed = encodeShipTelemetry(fullReadings());
  assert.ok(packed instanceof Uint8Array);
  const doc = decodeShipTelemetry(packed);
  assert.equal(doc.v, SCHEMA_VERSION);
  assert.equal(doc.ts, 1700000000);
  assert.equal(doc.vessel.name, "Meri Imperiumi");
  assert.equal(doc.vessel.mmsi, "230001234");
  assert.equal(doc.vessel.shipType, 36);
  assert.equal(doc.nav.sog, 5.0);
  assert.equal(doc.nav.lat, 60.175987);
  assert.equal(doc.env.pressure, 101325);
  assert.equal(doc.env.humidity, 0.55);
});

test("encodeShipTelemetry omits absent sections and ignores non-finite numbers", () => {
  const packed = encodeShipTelemetry({
    now: 1,
    latitude: 1,
    longitude: 2,
    sog: NaN,
    cog: Infinity,
    name: "X",
  });
  const doc = decodeShipTelemetry(packed);
  assert.equal(doc.vessel.name, "X");
  assert.ok(!("mmsi" in doc.vessel));
  assert.equal(doc.nav.lat, 1);
  assert.equal(doc.nav.lon, 2);
  assert.ok(!("sog" in doc.nav));
  assert.ok(!("cog" in doc.nav));
  assert.ok(!("env" in doc));
});

test("encodeShipTelemetry returns null when there is nothing worth sending", () => {
  assert.equal(encodeShipTelemetry({ now: 1 }), null);
  assert.equal(encodeShipTelemetry({ now: 1, windSpeed: 5 }), null); // weather-only
  assert.equal(encodeShipTelemetry(undefined), null);
});

test("encodeShipTelemetry stamps the send time when `now` is absent", () => {
  const before = Math.floor(Date.now() / 1000);
  const doc = decodeShipTelemetry(encodeShipTelemetry({ name: "X" }));
  const after = Math.floor(Date.now() / 1000);
  assert.ok(doc.ts >= before && doc.ts <= after);
});

test("decodeShipTelemetry tolerates malformed/absent input", () => {
  assert.equal(decodeShipTelemetry(null), null);
  assert.equal(decodeShipTelemetry(undefined), null);
  // Not valid msgpack.
  assert.equal(decodeShipTelemetry(new Uint8Array([0xff, 0xff])), null);
  // A msgpack array is not a valid document.
  assert.equal(
    decodeShipTelemetry(
      encodeShipTelemetry({ name: "x" }) && new Uint8Array([0x90]),
    ),
    null,
  );
});

// --- value mapping ----------------------------------------------------------

test("shipTelemetryToValues maps every field to a standard Signal K path", () => {
  const doc = decodeShipTelemetry(encodeShipTelemetry(fullReadings()));
  const byPath = Object.fromEntries(
    shipTelemetryToValues(doc).map((v) => [v.path, v.value]),
  );
  assert.equal(byPath["mmsi"], "230001234");
  assert.equal(byPath["communication.callsignVhf"], "OH1234");
  assert.deepEqual(byPath["design.aisShipType"], { id: 36 });
  assert.equal(byPath["design.draft.maximum"], 2.1);
  assert.equal(byPath["design.length.overall"], 12.5);
  assert.equal(byPath["design.beam"], 4.0);
  assert.deepEqual(byPath["navigation.position"], {
    latitude: 60.175987,
    longitude: -21.094551,
  });
  assert.equal(byPath["navigation.speedOverGround"], 5.0);
  assert.equal(byPath["navigation.courseOverGroundTrue"], 0.5);
  assert.equal(byPath["navigation.headingTrue"], 0.4);
  assert.equal(byPath["navigation.state"], "under way using engine");
  assert.equal(byPath["environment.wind.speedTrue"], 6.2);
  assert.equal(byPath["environment.wind.directionTrue"], 1.5);
  assert.equal(byPath["environment.outside.pressure"], 101325);
  assert.equal(byPath["environment.outside.temperature"], 293.15);
  assert.equal(byPath["environment.outside.relativeHumidity"], 0.55);
  assert.equal(byPath["navigation.destination.commonName"], "HELSINKI");
});

test("shipTelemetryToValues carries SI units through unchanged (no conversion)", () => {
  const doc = decodeShipTelemetry(
    encodeShipTelemetry({
      now: 1,
      latitude: 1,
      longitude: 2,
      sog: 5, // m/s stays m/s
      cog: Math.PI / 2, // rad stays rad
      pressure: 101000, // Pa stays Pa
      temp: 290, // K stays K
    }),
  );
  const byPath = Object.fromEntries(
    shipTelemetryToValues(doc).map((v) => [v.path, v.value]),
  );
  assert.equal(byPath["navigation.speedOverGround"], 5);
  assert.equal(byPath["navigation.courseOverGroundTrue"], Math.PI / 2);
  assert.equal(byPath["environment.outside.pressure"], 101000);
  assert.equal(byPath["environment.outside.temperature"], 290);
});

test("shipTelemetryToValues yields nothing for an empty document", () => {
  assert.deepEqual(shipTelemetryToValues({ v: 1, ts: 1 }), []);
  assert.deepEqual(shipTelemetryToValues(null), []);
});

// --- delta builder ----------------------------------------------------------

test("buildShipTelemetryDelta keys a vessel by MMSI when present", async () => {
  const sender = await Identity.generate();
  const delta = buildShipTelemetryDelta(
    makeRfedMessage(fullReadings(), sender),
  );
  assert.ok(delta);
  assert.equal(delta.context, "vessels.urn:mrn:imo:mmsi:230001234");
  assert.equal(delta.name, "Meri Imperiumi");
  // Update timestamp comes from the LXMF message send time, not "now".
  assert.equal(
    delta.updates[0].timestamp,
    new Date((1700000000 + 500) * 1000).toISOString(),
  );
  // Source label/src carry the sender identity hash.
  const senderHex = toHex(sender.identityHash);
  assert.equal(delta.updates[0].source.label, "signalk-reticulum");
  assert.equal(delta.updates[0].source.src, senderHex);
  // Provenance paths are recorded.
  const byPath = Object.fromEntries(
    delta.updates[0].values.filter((v) => v.path).map((v) => [v.path, v.value]),
  );
  assert.equal(byPath["communication.reticulum.identityHash"], senderHex);
  assert.equal(
    byPath["communication.reticulum.lxmfDestination"],
    toHex(fromHex("ab".repeat(16))),
  );
  // The vessel name is injected via an empty path.
  assert.ok(
    delta.updates[0].values.some(
      (v) => v.path === "" && v.value.name === "Meri Imperiumi",
    ),
  );
});

test("buildShipTelemetryDelta falls back to the identity-hash context without MMSI", async () => {
  const sender = await Identity.generate();
  const delta = buildShipTelemetryDelta(
    makeRfedMessage({ now: 1, latitude: 1, longitude: 2 }, sender),
  );
  assert.equal(
    delta.context,
    `vessels.urn:reticulum:identity:${toHex(sender.identityHash)}`,
  );
  // No MMSI => name falls back to the identity hash.
  assert.equal(delta.name, toHex(sender.identityHash));
});

test("buildShipTelemetryDelta drops unsigned/forged messages", async () => {
  const sender = await Identity.generate();
  assert.equal(
    buildShipTelemetryDelta(
      makeRfedMessage(fullReadings(), sender, { signatureValid: false }),
    ),
    null,
  );
});

test("buildShipTelemetryDelta returns null for absent telemetry / unknown sender", async () => {
  const sender = await Identity.generate();
  assert.equal(
    buildShipTelemetryDelta({
      message: { timestamp: 1, fields: {} },
      senderIdentity: sender,
      signatureValid: true,
    }),
    null,
  );
  assert.equal(
    buildShipTelemetryDelta(
      makeRfedMessage(fullReadings(), { identityHash: null }),
    ),
    null,
  );
  assert.equal(buildShipTelemetryDelta(null), null);
});

test("buildShipTelemetryDelta never produces a vessels.self context", async () => {
  const sender = await Identity.generate();
  // Even with our own identity echoed back, the delta context is identity/mmsi
  // keyed — the self-guard lives in the orchestrator, but the builder itself
  // can never emit vessels.self by construction.
  for (const readings of [
    fullReadings(),
    { now: 1, latitude: 1, longitude: 2 },
    { now: 1, name: "x", mmsi: "1" },
  ]) {
    const delta = buildShipTelemetryDelta(makeRfedMessage(readings, sender));
    assert.ok(delta);
    assert.notEqual(delta.context, "vessels.self");
    assert.match(
      delta.context,
      /^vessels\.urn:(mrn:imo:mmsi:|reticulum:identity:)/,
    );
  }
});

// --- orchestrator -----------------------------------------------------------

test("handleInboundShipTelemetry populates Signal K for a signed publisher", async () => {
  const sender = await Identity.generate();
  const { app, messages, debugs } = makeApp();
  const ok = handleInboundShipTelemetry(
    makeRfedMessage(fullReadings(), sender),
    { rfed: { receive_telemetry: true } },
    app,
  );
  assert.equal(ok, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "signalk-reticulum");
  assert.equal(messages[0].delta.context, "vessels.urn:mrn:imo:mmsi:230001234");
  assert.ok(debugs.some((m) => /Populated ship telemetry/.test(m)));
});

test("handleInboundShipTelemetry does nothing when receive is disabled", async () => {
  const sender = await Identity.generate();
  const { app, messages } = makeApp();
  assert.equal(
    handleInboundShipTelemetry(
      makeRfedMessage(fullReadings(), sender),
      {
        rfed: { receive_telemetry: false },
      },
      app,
    ),
    false,
  );
  assert.equal(messages.length, 0);
});

test("handleInboundShipTelemetry drops an unsigned message and logs it", async () => {
  const sender = await Identity.generate();
  const { app, messages, debugs } = makeApp();
  assert.equal(
    handleInboundShipTelemetry(
      makeRfedMessage(fullReadings(), sender, { signatureValid: false }),
      { rfed: { receive_telemetry: true } },
      app,
    ),
    false,
  );
  assert.equal(messages.length, 0);
  assert.ok(debugs.some((m) => /signature invalid/.test(m)));
});

test("handleInboundShipTelemetry ignores the node's own echo (identity match)", async () => {
  const sender = await Identity.generate();
  const { app, messages, debugs } = makeApp();
  assert.equal(
    handleInboundShipTelemetry(
      makeRfedMessage(fullReadings(), sender),
      { rfed: { receive_telemetry: true } },
      app,
      toHex(sender.identityHash),
    ),
    false,
  );
  assert.equal(messages.length, 0);
  assert.ok(debugs.some((m) => /own RFed telemetry echo/.test(m)));
});

test("handleInboundShipTelemetry drops + logs another publisher claiming our MMSI", async () => {
  const sender = await Identity.generate();
  const { app, messages, errors } = makeApp();
  assert.equal(
    handleInboundShipTelemetry(
      makeRfedMessage(fullReadings(), sender),
      { rfed: { receive_telemetry: true } },
      app,
      "0".repeat(32), // a different self identity
      "230001234", // ...but the snapshot carries OUR mmsi
    ),
    false,
  );
  assert.equal(messages.length, 0);
  assert.ok(
    errors.some((m) =>
      /claims our own MMSI \(230001234\).*dropping to protect vessels\.self/.test(
        m,
      ),
    ),
  );
  // The offender's identity hash is included for traceability.
  assert.ok(errors.some((m) => m.includes(toHex(sender.identityHash))));
});

test("handleInboundShipTelemetry is a no-op without app.handleMessage", async () => {
  const sender = await Identity.generate();
  assert.equal(
    handleInboundShipTelemetry(
      makeRfedMessage(fullReadings(), sender),
      {
        rfed: { receive_telemetry: true },
      },
      { debug() {} },
    ),
    false,
  );
});

// --- publisher --------------------------------------------------------------

test("makeShipTelemetryPublisher wraps the snapshot in FIELD_TELEMETRY and publishes it", async () => {
  const calls = [];
  const fakeClient = {
    async publish(nodeHash, channel, message) {
      calls.push({ nodeHash, channel, message });
    },
  };
  const NODE = "ab".repeat(16);
  const publish = makeShipTelemetryPublisher(
    fakeClient,
    NODE,
    "public.signalk.vessels",
  );
  const packed = encodeShipTelemetry(fullReadings());
  await publish(packed);
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0].nodeHash], [...fromHex(NODE)]);
  assert.equal(calls[0].channel, "public.signalk.vessels");
  const fields = calls[0].message.fields;
  assert.ok(fields instanceof Map);
  assert.deepEqual(fields.get(FIELD_TELEMETRY), packed);
  // No-op when there is nothing to publish / no client.
  await publish(null);
  await makeShipTelemetryPublisher(null, NODE, "x")(packed);
  assert.equal(calls.length, 1);
});

// --- setupRFed (with a fake client) ----------------------------------------

test("setupRFed announces the delivery destination, subscribes and re-subscribes, and tears down", async () => {
  const listenCalls = [];
  const subscribeCalls = [];
  /** A minimal RFedClient fake that fires subscribe immediately + on a timer. */
  class FakeRFedClient {
    constructor({ identity, rns }) {
      this.identity = identity;
      this.rns = rns;
    }
    async listen(onMessage) {
      listenCalls.push(onMessage);
      return fromHex("11".repeat(16));
    }
    async subscribe(nodeHash, channel) {
      subscribeCalls.push({ nodeHash, channel });
      return { ok: true, stampCost: 0 };
    }
  }
  const realClient = rfed.deps.RFedClient;
  rfed.deps.RFedClient = FakeRFedClient;
  try {
    const identity = await Identity.generate();
    const rns = { transport: { bindLocalDestination() {} } };
    const onMessage = () => {};
    const setup = await setupRFed(
      rns,
      identity,
      {
        nodeHashHex: "cd".repeat(16),
        channel: "public.signalk.vessels",
        subscribeIntervalMs: 5,
      },
      onMessage,
      () => {},
    );
    assert.equal(listenCalls.length, 1);
    assert.equal(listenCalls[0], onMessage);
    assert.equal(setup.deliveryHashHex, "11".repeat(16));
    // Immediate subscribe fired synchronously after listen.
    assert.ok(subscribeCalls.length >= 1);
    assert.equal(subscribeCalls[0].channel, "public.signalk.vessels");
    // Let the periodic re-subscribe fire at least once.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(subscribeCalls.length >= 2);
    setup.teardown();
    const countAtTeardown = subscribeCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(subscribeCalls.length, countAtTeardown); // no more after teardown
    assert.ok(setup.client instanceof FakeRFedClient);
  } finally {
    rfed.deps.RFedClient = realClient;
  }
});

test("setupRFed requires a node hash and channel", async () => {
  const identity = await Identity.generate();
  await assert.rejects(
    setupRFed(
      {},
      identity,
      { nodeHashHex: "", channel: "x" },
      () => {},
      () => {},
    ),
    /nodeHashHex and channel/,
  );
});

test("setupRFed keeps coming up when listen/subscribe fail (best-effort)", async () => {
  class FakeRFedClient {
    async listen() {
      throw new Error("listen boom");
    }
    async subscribe() {
      throw new Error("subscribe boom");
    }
  }
  const realClient = rfed.deps.RFedClient;
  rfed.deps.RFedClient = FakeRFedClient;
  const debugs = [];
  try {
    const identity = await Identity.generate();
    const setup = await setupRFed(
      { transport: { bindLocalDestination() {} } },
      identity,
      { nodeHashHex: "cd".repeat(16), channel: "public.signalk.vessels" },
      () => {},
      (m) => debugs.push(m),
    );
    assert.ok(debugs.some((m) => /rfed listen failed/.test(m)));
    assert.ok(debugs.some((m) => /rfed subscribe .* failed/.test(m)));
    setup.teardown();
  } finally {
    rfed.deps.RFedClient = realClient;
  }
});

// --- embedded RFed node (real in-process RFedNode) -------------------------
//
// The embedded node and its "client" share one Reticulum instance and
// identity, so the link-based RFedClient used for a *remote* node can't reach
// the local destination. These smoketests exercise the in-process wiring
// (transmit via direct ingest, receive via a fanout tap) against a REAL
// RFedNode + Reticulum — no fakes — to prove the embedded node behaves like a
// normal federation node: blobs are stored and (when there are subscribers)
// would fan out over the mesh, and inbound blobs reach the telemetry handler.

/** Builds a real in-process RFedNode (stamp-cost disabled) for smoketesting. */
async function makeEmbeddedNode() {
  const rns = new Reticulum({ requireDestinationProof: false });
  const identity = await Identity.generate();
  const node = new RFedNode({
    identity,
    rns,
    stores: {
      blobStore: new BlobStore(),
      subscriptions: new SubscriptionTable(),
      deferred: new DeferredQueue(),
      notify: new NotifyRegistry(),
    },
    // No PoW stamp required so smoketests can publish without mining a stamp.
    config: { name: "rfed", stampCost: 0, stampFlexibility: 0 },
  });
  await node.start();
  return { rns, identity, node };
}

/** Wraps a packed snapshot as a SEND payload from `senderIdentity` on `channel`. */
async function wrapRemoteSendPayload(channel, senderIdentity, packed) {
  const {
    deriveChannel,
    deliveryHashFor,
  } = require("@reticulum/core/src/rfed/channel.js");
  const { wrapChannelMessage } = require("@reticulum/core/src/rfed/blob.js");
  const { identity: channelIdentity } = await deriveChannel(channel);
  const senderLxmDeliveryHash = await deliveryHashFor(senderIdentity);
  const message = new rfed.deps.LXMessage({
    sourceHash: new Uint8Array(16),
    destinationHash: new Uint8Array(16),
    title: "",
    content: "",
    fields: new Map([[FIELD_TELEMETRY, packed]]),
  });
  const { rfedPayload } = await wrapChannelMessage({
    channelIdentity,
    senderIdentity,
    senderLxmDeliveryHash,
    lxmMessage: message,
    stampCost: null,
  });
  return rfedPayload;
}

test("makeEmbeddedShipTelemetryPublisher stores the blob in the embedded node", async () => {
  const { rns, identity, node } = await makeEmbeddedNode();
  try {
    const publish = makeEmbeddedShipTelemetryPublisher(
      node,
      identity,
      DEFAULT_CHANNEL,
    );
    assert.equal(node.blobStore.allMessageIds().length, 0);
    await publish(encodeShipTelemetry(fullReadings()));
    // Direct ingest stores the blob — surfaced as `rfedBlobsStored` in status.
    assert.equal(node.blobStore.allMessageIds().length, 1);
    // A no-op publish (nothing to send) does not store a second blob.
    await publish(null);
    assert.equal(node.blobStore.allMessageIds().length, 1);
  } finally {
    await node.stop();
    await rns.stop();
  }
});

test("setupEmbeddedRFedClient decodes blobs the node ingests (simulated remote publish)", async () => {
  const { rns, identity, node } = await makeEmbeddedNode();
  try {
    const received = [];
    const client = await setupEmbeddedRFedClient(
      node,
      DEFAULT_CHANNEL,
      (decoded) => received.push(decoded),
      () => {},
    );
    // Simulate a remote boat's SEND payload arriving at the publish dest.
    const remote = await Identity.generate();
    const packed = encodeShipTelemetry(fullReadings());
    const payload = await wrapRemoteSendPayload(
      DEFAULT_CHANNEL,
      remote,
      packed,
    );
    await node._handleSend(payload);

    assert.equal(received.length, 1);
    const decoded = received[0];
    assert.equal(decoded.signatureValid, true);
    assert.equal(
      toHex(decoded.senderIdentity.identityHash),
      toHex(remote.identityHash),
    );
    assert.equal(decoded.channelName, DEFAULT_CHANNEL);
    // The telemetry round-trips through the canonical codec.
    const doc = decodeShipTelemetry(
      extractTelemetryField(decoded.message.fields),
    );
    assert.equal(doc.vessel.name, "Meri Imperiumi");
    assert.equal(doc.vessel.mmsi, "230001234");
    client.teardown();
  } finally {
    await node.stop();
    await rns.stop();
  }
});

test("setupEmbeddedRFedClient delivers the node's own echo (self-identity guard is one layer up)", async () => {
  const { rns, identity, node } = await makeEmbeddedNode();
  try {
    const received = [];
    const client = await setupEmbeddedRFedClient(
      node,
      DEFAULT_CHANNEL,
      (decoded) => received.push(decoded),
      () => {},
    );
    const publish = makeEmbeddedShipTelemetryPublisher(
      node,
      identity,
      DEFAULT_CHANNEL,
    );
    await publish(encodeShipTelemetry(fullReadings()));
    // The node's own publish is fanned out and decoded; the self-echo drop
    // happens in `handleInboundShipTelemetry` (covered by its own tests), not
    // at this layer — matching how the remote path handles its own echo.
    assert.equal(received.length, 1);
    assert.equal(
      toHex(received[0].senderIdentity.identityHash),
      toHex(identity.identityHash),
    );
    client.teardown();
  } finally {
    await node.stop();
    await rns.stop();
  }
});

test("setupEmbeddedRFedClient teardown restores the original fanout (no more delivery)", async () => {
  const { rns, identity, node } = await makeEmbeddedNode();
  try {
    const received = [];
    const client = await setupEmbeddedRFedClient(
      node,
      DEFAULT_CHANNEL,
      (decoded) => received.push(decoded),
      () => {},
    );
    client.teardown();
    const remote = await Identity.generate();
    const payload = await wrapRemoteSendPayload(
      DEFAULT_CHANNEL,
      remote,
      encodeShipTelemetry(fullReadings()),
    );
    await node._handleSend(payload);
    assert.equal(received.length, 0);
    // The blob is still stored (ingest is independent of the receive tap).
    assert.equal(node.blobStore.allMessageIds().length, 1);
  } finally {
    await node.stop();
    await rns.stop();
  }
});

test("setupEmbeddedRFedClient ignores blobs for a different channel", async () => {
  const { rns, identity, node } = await makeEmbeddedNode();
  try {
    const received = [];
    const client = await setupEmbeddedRFedClient(
      node,
      "public.signalk.vessels",
      (decoded) => received.push(decoded),
      (m) => {
        throw new Error(`unexpected debug: ${m}`);
      },
    );
    // Publish on a different channel; the tap must skip it without throwing.
    const other = "private.fleet.alpha";
    const remote = await Identity.generate();
    const payload = await wrapRemoteSendPayload(
      other,
      remote,
      encodeShipTelemetry(fullReadings()),
    );
    await node._handleSend(payload);
    assert.equal(received.length, 0);
    client.teardown();
  } finally {
    await node.stop();
    await rns.stop();
  }
});
