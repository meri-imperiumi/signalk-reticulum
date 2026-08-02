const test = require("node:test");
const assert = require("node:assert/strict");

const { fromHex, toHex } = require("@reticulum/core");
const { deriveLxmfDestinationHash } = require("../plugin/identity");
const {
  SID,
  FIELD_TELEMETRY,
  packLocation,
  packBattery,
  packTemperature,
  packPressure,
  packHumidity,
  packTelemetry,
  buildTelemetrySensors,
} = require("../plugin/telemetry");
const {
  crewEntries,
  matchCrewBySource,
  crewContext,
  sourceInstanceId,
  telemetryToValues,
  buildCrewTelemetryDelta,
  sendInboundTelemetryMeta,
  handleInboundTelemetry,
  DEG_TO_RAD,
  MS_TO_KMH,
  KELVIN_OFFSET,
} = require("../plugin/inbound");

/** A canonical 32-hex-char crew identity hash used across the tests. */
const CREW_IDENTITY = "7a3c9f1b2e4d58607a3c9f1b2e4d5860";
/** That crew member's derived lxmf.delivery destination hash. */
const CREW_LXMF = deriveLxmfDestinationHash(CREW_IDENTITY);
/** The same hash as raw bytes, matching an inbound message's sourceHash. */
const CREW_SOURCE = fromHex(CREW_LXMF);

/** Builds a packed Sideband telemetry snapshot for the given readings. */
function snapshot(readings) {
  return packTelemetry(buildTelemetrySensors(readings), readings.now);
}

/** Builds an LXMF fields object (deserialized shape: plain object, str keys). */
function fieldsObject(packed) {
  return { [FIELD_TELEMETRY]: packed };
}

/** Minimal recording Signal K app stand-in capturing handleMessage calls. */
function makeApp() {
  /** @type {any[]} */
  const messages = [];
  /** @type {string[]} */
  const debugs = [];
  const app = {
    debug(msg) {
      debugs.push(msg);
    },
    handleMessage(id, delta) {
      messages.push({ id, delta });
    },
  };
  return { app, messages, debugs };
}

test("crewEntries derives the lxmf.delivery hash from a configured identity hash", () => {
  const entries = crewEntries([{ name: "Alice", identity: CREW_IDENTITY }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "Alice");
  assert.equal(entries[0].identityHash, CREW_IDENTITY);
  assert.equal(entries[0].destinationHash, CREW_LXMF);
});

test("crewEntries keeps a legacy raw destination hash with no identity", () => {
  const entries = crewEntries([
    { name: "Bob", destination: CREW_LXMF.toUpperCase() },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].identityHash, null);
  assert.equal(entries[0].destinationHash, CREW_LXMF);
});

test("crewEntries skips invalid entries", () => {
  assert.deepEqual(crewEntries(undefined), []);
  assert.deepEqual(crewEntries([]), []);
  assert.deepEqual(
    crewEntries([{ name: "x" }, { identity: "nothex" }, null]),
    [],
  );
});

test("matchCrewBySource matches a message source hash to a crew member", () => {
  const crew = [{ name: "Alice", identity: CREW_IDENTITY }];
  const member = matchCrewBySource(CREW_SOURCE, crew);
  assert.equal(member && member.name, "Alice");
  assert.equal(member && member.destinationHash, CREW_LXMF);
});

test("matchCrewBySource returns null for an unknown sender", () => {
  const other = fromHex("0".repeat(31) + "1");
  assert.equal(
    matchCrewBySource(other, [{ name: "Alice", identity: CREW_IDENTITY }]),
    null,
  );
  assert.equal(matchCrewBySource(null, []), null);
});

test("crewContext keys a crew member by their identity hash", () => {
  const member = { identityHash: CREW_IDENTITY, destinationHash: CREW_LXMF };
  assert.equal(
    crewContext(member),
    `vessels.urn:reticulum:identity:${CREW_IDENTITY}`,
  );
});

test("crewContext falls back to the destination hash when no identity is known", () => {
  const member = { identityHash: null, destinationHash: CREW_LXMF };
  assert.equal(
    crewContext(member),
    `vessels.urn:reticulum:identity:${CREW_LXMF}`,
  );
  assert.equal(crewContext(null), null);
});

test("sourceInstanceId returns a short, stable hex id", () => {
  assert.equal(sourceInstanceId(CREW_IDENTITY), CREW_IDENTITY.slice(0, 8));
  assert.equal(sourceInstanceId(CREW_LXMF), CREW_LXMF.slice(0, 8));
  // Non-hex characters are stripped before slicing.
  assert.equal(sourceInstanceId("ab-cd-ef-01-23-45-67-89"), "abcdef01");
});

test("telemetryToValues converts units: km/h -> m/s, deg -> rad, % -> ratio", () => {
  const values = telemetryToValues(
    {
      latitude: 60.1,
      longitude: 21.1,
      altitudeM: 5,
      speedKmh: 18, // -> 5 m/s
      bearingDeg: 180, // -> pi rad
      battery: { chargePercent: 75, charging: true, temperature: null },
    },
    "deadbeef",
  );

  const byPath = Object.fromEntries(values.map((v) => [v.path, v.value]));
  assert.deepEqual(byPath["navigation.position"], {
    latitude: 60.1,
    longitude: 21.1,
  });
  assert.equal(byPath["navigation.speedOverGround"], 18 / MS_TO_KMH);
  assert.equal(byPath["navigation.courseOverGroundTrue"], 180 * DEG_TO_RAD);
  assert.equal(byPath["navigation.gnss.antennaAltitude"], 5);
  assert.equal(
    byPath["electrical.batteries.deadbeef.capacity.stateOfCharge"],
    0.75,
  );
});

test("telemetryToValues converts scalar environment sensors to Signal K units", () => {
  const values = telemetryToValues(
    {
      temperatureC: 22.5, // -> 296.65 K
      pressureMbar: 1013.25, // -> 101325 Pa
      humidityPercent: 55, // -> 0.55
    },
    "deadbeef",
  );
  const byPath = Object.fromEntries(values.map((v) => [v.path, v.value]));
  assert.equal(byPath["environment.outside.temperature"], 22.5 + KELVIN_OFFSET);
  assert.equal(byPath["environment.outside.pressure"], 1013.25 * 100);
  assert.equal(byPath["environment.outside.relativeHumidity"], 0.55);
});

test("telemetryToValues omits absent readings and yields nothing for an empty snapshot", () => {
  assert.deepEqual(telemetryToValues({}, "x"), []);
  // Non-finite numbers are skipped.
  assert.deepEqual(telemetryToValues({ latitude: NaN, longitude: 1 }, "x"), []);
});

test("buildCrewTelemetryDelta builds a named, identity-keyed delta for crew", () => {
  const packed = snapshot({
    latitude: 60.1,
    longitude: 21.1,
    speedMs: 5,
    bearingRad: Math.PI,
    batteryPercent: 80,
    now: 1700000000,
  });
  const delta = buildCrewTelemetryDelta(CREW_SOURCE, fieldsObject(packed), [
    { name: "Alice", identity: CREW_IDENTITY },
  ]);
  assert.ok(delta);
  assert.equal(delta.name, "Alice");
  assert.equal(
    delta.context,
    `vessels.urn:reticulum:identity:${CREW_IDENTITY}`,
  );
  assert.equal(delta.updates.length, 1);
  const values = delta.updates[0].values;
  const byPath = Object.fromEntries(
    values.filter((v) => v.path).map((v) => [v.path, v.value]),
  );
  assert.deepEqual(byPath["navigation.position"], {
    latitude: 60.1,
    longitude: 21.1,
  });
  // The crew member's name is injected via an empty path.
  assert.ok(values.some((v) => v.path === "" && v.value.name === "Alice"));
  // Identity / destination are recorded for traceability.
  assert.equal(byPath["communication.reticulum.identityHash"], CREW_IDENTITY);
  assert.equal(byPath["communication.reticulum.lxmfDestination"], CREW_LXMF);
  // Source label/src are set for the update.
  assert.equal(delta.updates[0].source.label, "signalk-reticulum");
  assert.equal(delta.updates[0].source.src, CREW_LXMF);
});

test("buildCrewTelemetryDelta accepts a Map fields shape too", () => {
  const packed = snapshot({
    latitude: 1,
    longitude: 2,
    batteryPercent: 50,
    now: 1,
  });
  const fields = new Map([[FIELD_TELEMETRY, packed]]);
  const delta = buildCrewTelemetryDelta(CREW_SOURCE, fields, [
    { name: "Alice", identity: CREW_IDENTITY },
  ]);
  assert.ok(delta);
});

test("buildCrewTelemetryDelta returns null for a non-crew sender (crew-only)", () => {
  const packed = snapshot({ latitude: 1, longitude: 2, now: 1 });
  const stranger = fromHex("f".repeat(31) + "e");
  assert.equal(
    buildCrewTelemetryDelta(stranger, fieldsObject(packed), [
      { name: "Alice", identity: CREW_IDENTITY },
    ]),
    null,
  );
});

test("buildCrewTelemetryDelta returns null when the message has no telemetry field", () => {
  assert.equal(
    buildCrewTelemetryDelta(CREW_SOURCE, {}, [
      { name: "Alice", identity: CREW_IDENTITY },
    ]),
    null,
  );
  assert.equal(
    buildCrewTelemetryDelta(CREW_SOURCE, null, [
      { name: "Alice", identity: CREW_IDENTITY },
    ]),
    null,
  );
});

test("buildCrewTelemetryDelta returns null when the telemetry yields no values", () => {
  // A snapshot with no usable sensors (only time).
  const packed = packTelemetry({}, 1);
  assert.equal(
    buildCrewTelemetryDelta(CREW_SOURCE, fieldsObject(packed), [
      { name: "Alice", identity: CREW_IDENTITY },
    ]),
    null,
  );
});

test("sendInboundTelemetryMeta publishes meta for the reticulum communication paths", () => {
  const { app, messages } = makeApp();
  sendInboundTelemetryMeta(app);
  assert.equal(messages.length, 1);
  const metaPaths = messages[0].delta.updates[0].meta.map((m) => m.path);
  assert.ok(metaPaths.includes("communication.reticulum.identityHash"));
  assert.ok(metaPaths.includes("communication.reticulum.lxmfDestination"));
});

test("sendInboundTelemetryMeta is a no-op without app.handleMessage", () => {
  const messages = [];
  sendInboundTelemetryMeta({ handleMessage: undefined });
  sendInboundTelemetryMeta(undefined);
  assert.equal(messages.length, 0);
});

// --- handleInboundTelemetry orchestrator ------------------------------------

test("handleInboundTelemetry populates Signal K for a crew member's telemetry", () => {
  const { app, messages, debugs } = makeApp();
  const packed = snapshot({
    latitude: 60.1,
    longitude: 21.1,
    batteryPercent: 80,
    now: 1700000000,
  });
  const ok = handleInboundTelemetry(
    { sourceHash: CREW_SOURCE, fields: fieldsObject(packed) },
    {
      telemetry: { populate_crew_telemetry: true },
      crew: [{ name: "Alice", identity: CREW_IDENTITY }],
    },
    app,
  );
  assert.equal(ok, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "signalk-reticulum");
  assert.equal(
    messages[0].delta.context,
    `vessels.urn:reticulum:identity:${CREW_IDENTITY}`,
  );
  assert.ok(debugs.some((m) => /Populated crew telemetry for Alice/.test(m)));
});

test("handleInboundTelemetry does nothing when the setting is disabled", () => {
  const { app, messages } = makeApp();
  const packed = snapshot({ latitude: 1, longitude: 2, now: 1 });
  const ok = handleInboundTelemetry(
    { sourceHash: CREW_SOURCE, fields: fieldsObject(packed) },
    {
      telemetry: { populate_crew_telemetry: false },
      crew: [{ name: "Alice", identity: CREW_IDENTITY }],
    },
    app,
  );
  assert.equal(ok, false);
  assert.equal(messages.length, 0);
});

test("handleInboundTelemetry does nothing when the message has no telemetry", () => {
  const { app, messages } = makeApp();
  const ok = handleInboundTelemetry(
    { sourceHash: CREW_SOURCE, fields: {} },
    {
      telemetry: { populate_crew_telemetry: true },
      crew: [{ name: "Alice", identity: CREW_IDENTITY }],
    },
    app,
  );
  assert.equal(ok, false);
  assert.equal(messages.length, 0);
});

test("handleInboundTelemetry drops telemetry from a non-crew sender and logs it", () => {
  const { app, messages, debugs } = makeApp();
  const packed = snapshot({ latitude: 1, longitude: 2, now: 1 });
  const stranger = fromHex("abcabcab" + "0".repeat(24));
  const ok = handleInboundTelemetry(
    { sourceHash: stranger, fields: fieldsObject(packed) },
    {
      telemetry: { populate_crew_telemetry: true },
      crew: [{ name: "Alice", identity: CREW_IDENTITY }],
    },
    app,
  );
  assert.equal(ok, false);
  assert.equal(messages.length, 0);
  assert.ok(
    debugs.some((m) =>
      /Dropping inbound telemetry from [0-9a-f]+: sender is not a configured crew member/.test(
        m,
      ),
    ),
  );
});

test("handleInboundTelemetry is a no-op without a source hash or app", () => {
  const packed = snapshot({ latitude: 1, longitude: 2, now: 1 });
  const settings = {
    telemetry: { populate_crew_telemetry: true },
    crew: [{ name: "Alice", identity: CREW_IDENTITY }],
  };
  assert.equal(
    handleInboundTelemetry(
      { fields: fieldsObject(packed) },
      settings,
      makeApp().app,
    ),
    false,
  );
  assert.equal(
    handleInboundTelemetry(
      { sourceHash: CREW_SOURCE, fields: fieldsObject(packed) },
      settings,
      { debug() {} }, // no handleMessage
    ),
    false,
  );
});

test("handleInboundTelemetry matches a crew member configured by a legacy destination hash", () => {
  const { app, messages } = makeApp();
  const packed = snapshot({ latitude: 1, longitude: 2, now: 1 });
  const ok = handleInboundTelemetry(
    { sourceHash: CREW_SOURCE, fields: fieldsObject(packed) },
    {
      telemetry: { populate_crew_telemetry: true },
      crew: [{ name: "Alice", destination: CREW_LXMF }],
    },
    app,
  );
  assert.equal(ok, true);
  assert.equal(messages.length, 1);
  // No identity hash available -> context keyed by the destination hash.
  assert.equal(
    messages[0].delta.context,
    `vessels.urn:reticulum:identity:${CREW_LXMF}`,
  );
});

test("a full inbound round-trip: packed snapshot -> Signal K delta with correct units", () => {
  const { app, messages } = makeApp();
  // Build a snapshot straight from a (simulated) crew device's readings and
  // pack it exactly as the outbound broadcaster does.
  const packed = snapshot({
    latitude: 60.175987,
    longitude: -21.094551,
    altitudeM: 12.5,
    speedMs: 5, // 18 km/h on the wire
    bearingRad: Math.PI, // 180 deg on the wire
    batteryPercent: 92.1,
    now: 1700000500,
  });
  handleInboundTelemetry(
    { sourceHash: CREW_SOURCE, fields: fieldsObject(packed) },
    {
      telemetry: { populate_crew_telemetry: true },
      crew: [{ name: "Alice", identity: CREW_IDENTITY }],
    },
    app,
  );
  const values = messages[0].delta.updates[0].values;
  const byPath = Object.fromEntries(
    values.filter((v) => v.path).map((v) => [v.path, v.value]),
  );
  // Units come back out in Signal K's preferred units.
  assert.deepEqual(byPath["navigation.position"], {
    latitude: 60.175987,
    longitude: -21.094551,
  });
  assert.equal(byPath["navigation.speedOverGround"], 5); // m/s again
  assert.equal(byPath["navigation.courseOverGroundTrue"], Math.PI); // rad
  assert.equal(byPath["navigation.gnss.antennaAltitude"], 12.5);
  assert.equal(
    Math.round(
      byPath[
        `electrical.batteries.${sourceInstanceId(CREW_IDENTITY)}.capacity.stateOfCharge`
      ] * 1000,
    ),
    921,
  );
});

// Keep the toHex import meaningful for the source-hash log assertions.
test("toHex round-trips the crew source hash", () => {
  assert.equal(toHex(CREW_SOURCE), CREW_LXMF);
});

// Sanity: SID constants used above exist.
test("SID constants are available", () => {
  assert.equal(typeof SID.LOCATION, "number");
  assert.equal(FIELD_TELEMETRY, 0x02);
});
