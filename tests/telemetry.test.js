const test = require("node:test");
const assert = require("node:assert/strict");

const { MsgPack } = require("@reticulum/core");
const {
  SID,
  FIELD_TELEMETRY,
  packLocation,
  packBattery,
  packCustom,
  packTank,
  packPressure,
  packTemperature,
  packHumidity,
  packInformation,
  packTelemetry,
  makeTelemetryFields,
  buildTelemetrySensors,
  unpackLocation,
  unpackBattery,
  unpackCustom,
  extractTelemetryField,
  decodeTelemetrySnapshot,
} = require("../plugin/telemetry");

/** Reads a 4-byte big-endian signed int out of a bin element. */
function readI32(bin) {
  return new DataView(bin.buffer, bin.byteOffset, bin.byteLength).getInt32(
    0,
    false,
  );
}

/** Reads a 4-byte big-endian unsigned int out of a bin element. */
function readU32(bin) {
  return new DataView(bin.buffer, bin.byteOffset, bin.byteLength).getUint32(
    0,
    false,
  );
}

/** Reads a 2-byte big-endian unsigned int out of a bin element. */
function readU16(bin) {
  return new DataView(bin.buffer, bin.byteOffset, bin.byteLength).getUint16(
    0,
    false,
  );
}

test("packLocation encodes lat/lon/alt as signed i32 and speed as unsigned u32 in the Sideband fixed-point format", () => {
  const loc = packLocation({
    latitude: 60.175987,
    longitude: -21.094551,
    altitude: 12.5,
    speedKmh: 18.4,
    bearingDeg: 214.3,
    accuracyM: 4.2,
    lastUpdate: 1700000000,
  });

  assert.equal(loc.length, 7);
  assert.equal(readI32(loc[0]), Math.round(60.175987 * 1e6));
  assert.equal(readI32(loc[1]), Math.round(-21.094551 * 1e6));
  assert.equal(readI32(loc[2]), Math.round(12.5 * 1e2));
  assert.equal(readU32(loc[3]), Math.round(18.4 * 1e2));
  assert.equal(readI32(loc[4]), Math.round(214.3 * 1e2));
  assert.equal(readU16(loc[5]), Math.round(4.2 * 1e2));
  assert.equal(loc[6], 1700000000);
  // The six fixed-width integers are raw bytes (bin), the timestamp an int.
  assert.ok(loc[0] instanceof Uint8Array);
  assert.equal(typeof loc[6], "number");
});

test("packLocation defaults altitude/speed/bearing/accuracy to zero when absent", () => {
  const loc = packLocation({
    latitude: 0,
    longitude: 0,
    lastUpdate: 1,
  });
  assert.equal(readI32(loc[2]), 0); // altitude
  assert.equal(readU32(loc[3]), 0); // speed
  assert.equal(readI32(loc[4]), 0); // bearing
  assert.equal(readU16(loc[5]), 0); // accuracy
});

test("packLocation returns null unless both latitude and longitude are present", () => {
  assert.equal(packLocation({ latitude: 1 }), null);
  assert.equal(packLocation({ longitude: 1 }), null);
  assert.equal(packLocation(null), null);
});

test("packBattery mirrors Battery.pack: [charge_percent, charging, temperature]", () => {
  assert.deepEqual(packBattery({ chargePercent: 87.34, charging: true }), [
    87.3,
    true,
    null,
  ]);
  assert.deepEqual(
    packBattery({ chargePercent: 50, charging: false, temperature: 24.5 }),
    [50, false, 24.5],
  );
  assert.equal(packBattery({}), null);
  assert.equal(packBattery(null), null);
});

test("packCustom produces [label, [value, icon]] entries and drops value-less ones", () => {
  assert.deepEqual(
    packCustom([
      { label: "Depth", value: "5.2 m", icon: "waves" },
      { label: "State", value: "anchored" },
      { label: "Empty", value: null },
    ]),
    [
      ["Depth", ["5.2 m", "waves"]],
      ["State", ["anchored", null]],
    ],
  );
  assert.deepEqual(packCustom(null), []);
});

test("packTank produces [label, [capacity, level, unit, icon]] entries", () => {
  assert.deepEqual(
    packTank([
      { label: "Fresh water", capacity: 1500, level: 728, unit: "L" },
      { capacity: 1, level: 1 },
    ]),
    [
      ["Fresh water", [1500, 728, "L", null]],
      [0x00, [1, 1, null, null]],
    ],
  );
});

test("pack scalar helpers round to two decimals and pass through null", () => {
  assert.equal(packPressure(1013.456), 1013.46);
  assert.equal(packPressure(null), null);
  assert.equal(packTemperature(22.345), 22.35);
  assert.equal(packTemperature(undefined), null);
  assert.equal(packHumidity(55.678), 55.68);
  assert.equal(packHumidity(null), null);
  assert.equal(packInformation("hello"), "hello");
  assert.equal(packInformation(null), null);
});

test("packTelemetry always includes the time sensor and emits integer SID keys on the wire", () => {
  const packed = packTelemetry(
    { location: packLocation({ latitude: 1, longitude: 2, lastUpdate: 3 }) },
    1700000123,
  );
  assert.ok(packed instanceof Uint8Array);
  // The on-wire map must have INTEGER keys (Sideband looks SIDs up by int).
  // A 2-entry fixmap (time + location) whose first key is the integer 0x01,
  // not the fixstr "1" (which would be 0xa1 0x31).
  assert.equal(packed[0], 0x82); // fixmap, 2 entries
  assert.equal(packed[1], 0x01); // integer key for SID_TIME
  const decoded = MsgPack.decode(packed);
  assert.deepEqual(Object.keys(decoded).sort(), ["1", "2"]);
  assert.equal(decoded["1"], 1700000123);
});

test("packTelemetry returns null when no sensors are provided", () => {
  assert.equal(packTelemetry({}), null);
  assert.equal(packTelemetry(null), null);
});

test("packTelemetry packs each provided sensor under its SID", () => {
  const packed = packTelemetry({
    location: packLocation({ latitude: 1, longitude: 2, lastUpdate: 3 }),
    battery: packBattery({ chargePercent: 80, charging: true }),
    custom: packCustom([{ label: "Depth", value: "5.0 m" }]),
  });
  const decoded = MsgPack.decode(packed);
  assert.deepEqual(
    Object.keys(decoded)
      .map(Number)
      .sort((a, b) => a - b),
    [1, 2, 4, 255],
  );
  assert.equal(decoded[SID.TIME], decoded[SID.TIME]); // time present
  assert.ok(Array.isArray(decoded[SID.LOCATION]));
  assert.deepEqual(decoded[SID.BATTERY], [80, true, null]);
  assert.deepEqual(decoded[SID.CUSTOM], [["Depth", ["5.0 m", null]]]);
});

test("makeTelemetryFields wraps the bytes under FIELD_TELEMETRY (0x02) with an integer key", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const fields = makeTelemetryFields(bytes);
  assert.ok(fields instanceof Map);
  assert.equal(fields.get(0x02), bytes);
  // On the wire the single-entry map uses an integer field id, not a string.
  const wire = Array.from(MsgPack.encode(fields));
  assert.deepEqual(wire.slice(0, 2), [0x81, 0x02]);
});

test("buildTelemetrySensors converts Signal K units and maps NomadNet readings to sensors", () => {
  const sensors = buildTelemetrySensors({
    latitude: 60.1,
    longitude: 21.1,
    altitudeM: 5,
    speedMs: 5, // -> 18 km/h
    bearingRad: Math.PI, // -> 180 deg
    batteryPercent: 87.5,
    batteryCharging: true,
    depthM: 5.25,
    tideHeightM: 1.3,
    tideState: "rising",
    windSpeedMs: 5, // -> ~10 kn
    windDirectionRad: 0, // -> 0 deg
    anchorDistanceM: 12.5,
    vesselState: "anchored",
    now: 1700000000,
  });

  // Location: speed converted m/s -> km/h, bearing rad -> deg.
  assert.ok(sensors.location);
  assert.equal(readU32(sensors.location[3]), Math.round(18 * 1e2));
  assert.equal(readI32(sensors.location[4]), Math.round(180 * 1e2));
  assert.equal(sensors.location[6], 1700000000);

  assert.deepEqual(sensors.battery, [87.5, true, null]);

  const custom = sensors.custom;
  const labels = custom.map((e) => e[0]);
  assert.deepEqual(labels, ["Depth", "Tide", "Wind", "Anchor", "State"]);
  assert.equal(custom[0][1][0], "5.3 m");
  assert.equal(custom[1][1][0], "1.3 m, rising");
  assert.equal(custom[2][1][0], "10 kn from 0°");
  assert.equal(custom[3][1][0], "12.5 m from bow");
  assert.equal(custom[4][1][0], "anchored");
});

test("buildTelemetrySensors omits absent readings and returns an empty object when nothing is available", () => {
  assert.deepEqual(buildTelemetrySensors({}), {});
  const onlyBattery = buildTelemetrySensors({ batteryPercent: 50 });
  assert.ok(!("location" in onlyBattery));
  assert.deepEqual(onlyBattery.battery, [50, false, null]);
  assert.ok(!("custom" in onlyBattery));
});

test("a full snapshot round-trips through Sideband-style decoding", () => {
  const sensors = buildTelemetrySensors({
    latitude: -33.8688,
    longitude: 151.2073,
    speedMs: 3,
    bearingRad: Math.PI / 2,
    batteryPercent: 92.1,
    depthM: 7,
    vesselState: "sailing",
    now: 1700000500,
  });
  const packed = packTelemetry(sensors, 1700000500);
  const decoded = MsgPack.decode(packed);

  // location decodes back to the scaled integers
  const loc = decoded[SID.LOCATION];
  assert.equal(readI32(loc[0]), Math.round(-33.8688 * 1e6));
  assert.equal(readI32(loc[1]), Math.round(151.2073 * 1e6));
  assert.deepEqual(decoded[SID.BATTERY], [92.1, false, null]);
  assert.ok(Array.isArray(decoded[SID.CUSTOM]));
});

// ---------------------------------------------------------------------------
// Inbound: unpackers (Sideband wire values → readings)
// ---------------------------------------------------------------------------

test("unpackLocation is the inverse of packLocation", () => {
  const packed = packLocation({
    latitude: 60.175987,
    longitude: -21.094551,
    altitude: 12.5,
    speedKmh: 18.4,
    bearingDeg: 214.3,
    accuracyM: 4.2,
    lastUpdate: 1700000000,
  });
  const loc = unpackLocation(packed);
  assert.deepEqual(loc, {
    latitude: 60.175987,
    longitude: -21.094551,
    altitudeM: 12.5,
    speedKmh: 18.4,
    bearingDeg: 214.3,
    accuracyM: 4.2,
    lastUpdate: 1700000000,
  });
});

test("unpackLocation returns null for missing or malformed input", () => {
  assert.equal(unpackLocation(null), null);
  assert.equal(unpackLocation(undefined), null);
  assert.equal(unpackLocation([]), null);
  assert.equal(unpackLocation([1, 2, 3]), null); // too few elements
});

test("unpackLocation tolerates a missing trailing timestamp", () => {
  const full = packLocation({ latitude: 1, longitude: 2, lastUpdate: 9 });
  // strip the trailing lastUpdate integer, leaving the six fixed-point ints
  const truncated = full.slice(0, 6);
  const loc = unpackLocation(truncated);
  assert.equal(loc.lastUpdate, undefined);
  assert.equal(loc.latitude, 1);
});

test("unpackBattery is the inverse of packBattery", () => {
  assert.deepEqual(
    unpackBattery(packBattery({ chargePercent: 87.3, charging: true })),
    {
      chargePercent: 87.3,
      charging: true,
      temperature: null,
    },
  );
  assert.deepEqual(
    unpackBattery(
      packBattery({ chargePercent: 50, charging: false, temperature: 24.5 }),
    ),
    { chargePercent: 50, charging: false, temperature: 24.5 },
  );
  assert.equal(unpackBattery(null), null);
  assert.equal(unpackBattery([]), null);
});

test("unpackCustom is the inverse of packCustom and drops malformed entries", () => {
  assert.deepEqual(
    unpackCustom(
      packCustom([
        { label: "Depth", value: "5.2 m", icon: "waves" },
        { label: "State", value: "anchored" },
      ]),
    ),
    [
      { label: "Depth", value: "5.2 m", icon: "waves" },
      { label: "State", value: "anchored", icon: null },
    ],
  );
  assert.deepEqual(unpackCustom(null), []);
  assert.deepEqual(unpackCustom([1, 2, ["x"]]), []);
});

test("extractTelemetryField pulls the snapshot from a deserialized fields object", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  // A deserialized LXMF message's fields is a plain object with string keys.
  const fields = { [FIELD_TELEMETRY]: bytes };
  assert.equal(extractTelemetryField(fields), bytes);
});

test("extractTelemetryField pulls the snapshot from a locally-built Map", () => {
  const bytes = new Uint8Array([9, 8]);
  const fields = makeTelemetryFields(bytes);
  assert.ok(fields instanceof Map);
  assert.equal(extractTelemetryField(fields), bytes);
});

test("extractTelemetryField returns null when there is no telemetry field", () => {
  assert.equal(extractTelemetryField(null), null);
  assert.equal(extractTelemetryField(undefined), null);
  assert.equal(extractTelemetryField({}), null);
  assert.equal(extractTelemetryField(new Map()), null);
  assert.equal(extractTelemetryField({ 3: new Uint8Array([1]) }), null);
});

test("decodeTelemetrySnapshot decodes a packed snapshot back into readings", () => {
  const sensors = buildTelemetrySensors({
    latitude: 60.1,
    longitude: 21.1,
    altitudeM: 5,
    speedMs: 5, // -> 18 km/h
    bearingRad: Math.PI, // -> 180 deg
    batteryPercent: 80,
    vesselState: "anchored",
    now: 1700000000,
  });
  const packed = packTelemetry(sensors, 1700000000);
  const readings = decodeTelemetrySnapshot(packed);

  assert.equal(readings.latitude, 60.1);
  assert.equal(readings.longitude, 21.1);
  assert.equal(readings.altitudeM, 5);
  assert.equal(readings.speedKmh, 18);
  assert.equal(readings.bearingDeg, 180);
  assert.equal(readings.lastUpdate, 1700000000);
  assert.deepEqual(readings.battery, {
    chargePercent: 80,
    charging: false,
    temperature: null,
  });
  assert.equal(readings.time, 1700000000);
  assert.ok(Array.isArray(readings.custom));
});

test("decodeTelemetrySnapshot decodes scalar environment sensors", () => {
  const packed = packTelemetry(
    {
      temperature: packTemperature(22.5),
      pressure: packPressure(1013.25),
      humidity: packHumidity(55.5),
      information: packInformation("Hello"),
    },
    1700000010,
  );
  const readings = decodeTelemetrySnapshot(packed);
  assert.equal(readings.temperatureC, 22.5);
  assert.equal(readings.pressureMbar, 1013.25);
  assert.equal(readings.humidityPercent, 55.5);
  assert.equal(readings.information, "Hello");
  assert.equal(readings.time, 1700000010);
});

test("decodeTelemetrySnapshot returns null for empty input", () => {
  assert.equal(decodeTelemetrySnapshot(null), null);
  assert.equal(decodeTelemetrySnapshot(undefined), null);
});

test("decodeTelemetrySnapshot ignores unknown sensor ids (forward compatible)", () => {
  // A snapshot carrying only an unknown SID still decodes (to a bare time +
  // the unknown sensor) without throwing.
  const map = new Map([
    [SID.TIME, 123],
    [0x99, "future sensor"],
  ]);
  const readings = decodeTelemetrySnapshot(MsgPack.encode(map));
  assert.equal(readings.time, 123);
});
