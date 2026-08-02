/**
 * Builds Sideband-compatible telemetry snapshots from Signal K self-path
 * values and packs them in the on-wire `Telemeter.packed()` format defined by
 * Sideband's `sbapp/sideband/sense.py`.
 *
 * Sideband telemetry is a single MessagePack map keyed by integer *sensor ids*
 * (SIDs), each mapping to that sensor's packed value. The whole map is carried
 * as the `FIELD_TELEMETRY` (0x02) field of an LXMF message, so any LXMF client
 * (Sideband, NomadNet, MeshChat) that understands telemetry will render it.
 *
 * The packed values deliberately mirror the Python reference byte-for-byte:
 *
 *   - `location`  (SID 0x02): a 7-element array of big-endian fixed-width
 *     integers (lat/lon/alt as signed i32, speed as unsigned u32 in km/h,
 *     bearing as signed i32 in degrees, accuracy as unsigned u16 in metres,
 *     plus a unix-seconds timestamp), each integer sent as raw `bin`.
 *   - `time`      (SID 0x01): a unix-seconds integer (always included).
 *   - `battery`   (SID 0x04): `[charge_percent, charging, temperature]`.
 *   - `custom`    (SID 0xff): `[[label, [value, icon]], ...]`.
 *
 * Integer MessagePack map keys require a `Map` (a plain object would serialise
 * its keys as strings), so {@link packTelemetry} builds the top-level map — and
 * {@link makeTelemetryFields} the LXMF fields map — with `Map`.
 *
 * Every function here is pure and free of Signal K / Reticulum coupling so it
 * can be unit-tested in isolation.
 *
 * @file telemetry.js
 */

const { MsgPack } = require("@reticulum/core");

/** Sensor ids, matching `sense.py` `Sensor.SID_*`. */
const SID = Object.freeze({
  TIME: 0x01,
  LOCATION: 0x02,
  PRESSURE: 0x03,
  BATTERY: 0x04,
  PHYSICAL_LINK: 0x05,
  ACCELERATION: 0x06,
  TEMPERATURE: 0x07,
  HUMIDITY: 0x08,
  MAGNETIC_FIELD: 0x09,
  AMBIENT_LIGHT: 0x0a,
  GRAVITY: 0x0b,
  ANGULAR_VELOCITY: 0x0c,
  PROXIMITY: 0x0e,
  INFORMATION: 0x0f,
  RECEIVED: 0x10,
  POWER_CONSUMPTION: 0x11,
  POWER_PRODUCTION: 0x12,
  PROCESSOR: 0x13,
  RAM: 0x14,
  NVM: 0x15,
  TANK: 0x16,
  FUEL: 0x17,
  LXMF_PROPAGATION: 0x18,
  RNS_TRANSPORT: 0x19,
  CONNECTION_MAP: 0x1a,
  INTERFACES: 0x1b,
  CUSTOM: 0xff,
});

/**
 * Encodes a signed 32-bit big-endian integer as 4 raw bytes (`struct.pack
 * "!i"`).
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
function i32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}

/**
 * Encodes an unsigned 32-bit big-endian integer as 4 raw bytes (`struct.pack
 * "!I"`).
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/**
 * Encodes an unsigned 16-bit big-endian integer as 2 raw bytes (`struct.pack
 * "!H"`).
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

/**
 * Packs a location reading into the Sideband `location` sensor wire value.
 *
 * Mirrors `Location.pack` in `sense.py`: each coordinate/derived value is
 * scaled to a fixed-point integer and serialised as a big-endian `bin` blob,
 * with the unix-seconds `lastUpdate` as the trailing integer. Returns `null`
 * unless both latitude and longitude are present (the minimum Sideband needs to
 * synthesise a location).
 *
 * Units expected on input (already converted from Signal K):
 *   - `latitude`, `longitude`  decimal degrees
 *   - `altitude`               metres (defaults to 0)
 *   - `speedKmh`               km/h            (Signal K SOG is m/s → ×3.6)
 *   - `bearingDeg`             degrees         (Signal K COG is rad → ×180/π)
 *   - `accuracyM`              metres          (defaults to 0)
 *   - `lastUpdate`             unix seconds
 *
 * @param {object} loc
 * @returns {Array|null}
 */
function packLocation(loc) {
  if (!loc || loc.latitude == null || loc.longitude == null) {
    return null;
  }
  const latitude = Math.round(loc.latitude * 1e6);
  const longitude = Math.round(loc.longitude * 1e6);
  const altitude = Math.round((loc.altitude || 0) * 1e2);
  const speed = Math.round((loc.speedKmh || 0) * 1e2);
  const bearing = Math.round((loc.bearingDeg || 0) * 1e2);
  const accuracy = Math.round((loc.accuracyM || 0) * 1e2);
  const lastUpdate = Math.floor(Number(loc.lastUpdate) || 0);
  return [
    i32(latitude),
    i32(longitude),
    i32(altitude),
    u32(speed),
    i32(bearing),
    u16(accuracy),
    lastUpdate,
  ];
}

/**
 * Packs a battery reading into the Sideband `battery` sensor wire value
 * `[charge_percent, charging, temperature]` (mirrors `Battery.pack`).
 * `temperature` is passed through unchanged (Sideband sends `None`).
 *
 * @param {object} battery
 * @param {number} battery.chargePercent - 0–100.
 * @param {boolean} [battery.charging]
 * @param {number|null} [battery.temperature]
 * @returns {Array|null}
 */
function packBattery(battery) {
  if (!battery || battery.chargePercent == null) {
    return null;
  }
  return [
    Math.round(battery.chargePercent * 10) / 10,
    !!battery.charging,
    battery.temperature == null ? null : battery.temperature,
  ];
}

/**
 * Packs custom sensor entries into the Sideband `custom` sensor wire value
 * `[[type_label, [value, custom_icon]], ...]` (mirrors `Custom.pack`). Entries
 * with neither a label nor a value are dropped; `custom_icon` is optional and
 * sent as `null` when absent.
 *
 * @param {Array<{label?:string, value:*, icon?:string|null}>} entries
 * @returns {Array}
 */
function packCustom(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const packed = [];
  for (const entry of entries) {
    if (!entry || entry.value == null) {
      continue;
    }
    const label = typeof entry.label === "string" ? entry.label : 0x00;
    packed.push([label, [entry.value, entry.icon == null ? null : entry.icon]]);
  }
  return packed;
}

/**
 * Packs a tank/fuel reading into the Sideband `tank`/`fuel` wire value
 * `[[type_label, [capacity, level, unit, custom_icon]], ...]` (mirrors
 * `Tank.pack` / `Fuel.pack`).
 *
 * @param {Array<{label?:string, capacity:number, level:number, unit?:string|null, icon?:string|null}>} entries
 * @returns {Array}
 */
function packTank(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const packed = [];
  for (const entry of entries) {
    if (!entry || entry.capacity == null || entry.level == null) {
      continue;
    }
    const label = typeof entry.label === "string" ? entry.label : 0x00;
    packed.push([
      label,
      [
        entry.capacity,
        entry.level,
        entry.unit == null ? null : entry.unit,
        entry.icon == null ? null : entry.icon,
      ],
    ]);
  }
  return packed;
}

/**
 * Packs an ambient pressure reading (mbar) into the Sideband `pressure` wire
 * value (mirrors `Pressure.pack`, which sends the bare mbar number).
 *
 * @param {number|null|undefined} mbar
 * @returns {number|null}
 */
function packPressure(mbar) {
  return mbar == null ? null : Math.round(mbar * 100) / 100;
}

/**
 * Packs a temperature reading (°C) into the Sideband `temperature` wire value
 * (mirrors `Temperature.pack`, which sends the bare celsius number).
 *
 * @param {number|null|undefined} celsius
 * @returns {number|null}
 */
function packTemperature(celsius) {
  return celsius == null ? null : Math.round(celsius * 100) / 100;
}

/**
 * Packs a relative-humidity reading (%) into the Sideband `humidity` wire value
 * (mirrors `Humidity.pack`).
 *
 * @param {number|null|undefined} percent
 * @returns {number|null}
 */
function packHumidity(percent) {
  return percent == null ? null : Math.round(percent * 100) / 100;
}

/**
 * Packs an information text blob into the Sideband `information` wire value
 * (mirrors `Information.pack`, which sends the contents string).
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
function packInformation(text) {
  if (text == null) {
    return null;
  }
  return String(text);
}

/**
 * Builds the full Sideband `Telemeter.packed()` bytes for a snapshot.
 *
 * `sensors` is keyed by human-readable sensor name; only present entries are
 * included, and the `time` sensor is always added (matching Sideband, which
 * enables it unconditionally). Each sensor value is the already-packed wire
 * value from the `pack*` helpers above. Returns `null` when no sensors at all
 * are available (nothing worth sending).
 *
 * The top-level structure is a MessagePack map with **integer** SID keys, so a
 * `Map` is used (a plain object would serialise keys as strings and break
 * Sideband's `Telemeter.from_packed`, which looks SIDs up by integer).
 *
 * @param {object} sensors - Packed sensor values keyed by name.
 * @param {Array} [sensors.location]
 * @param {Array} [sensors.battery]
 * @param {Array} [sensors.custom]
 * @param {Array} [sensors.tank]
 * @param {Array} [sensors.fuel]
 * @param {number|string} [sensors.pressure]
 * @param {number|string} [sensors.temperature]
 * @param {number|string} [sensors.humidity]
 * @param {string} [sensors.information]
 * @param {number} [now] - unix seconds for the time sensor (default: now).
 * @returns {Uint8Array|null}
 */
function packTelemetry(sensors = {}, now) {
  const entries = Object.entries(sensors || {}).filter(
    ([, value]) => value != null,
  );
  if (entries.length === 0) {
    return null;
  }
  const timestamp = Math.floor(Number(now) || Math.floor(Date.now() / 1000));
  const map = new Map([[SID.TIME, timestamp]]);
  for (const [name, value] of entries) {
    const sid = SID[(name || "").toUpperCase()];
    if (sid == null || value == null) {
      continue;
    }
    map.set(sid, value);
  }
  return MsgPack.encode(map);
}

/**
 * Wraps packed telemetry bytes in the LXMF `fields` map ready to pass as an
 * `LXMessage`'s `fields` option: a single `FIELD_TELEMETRY` (0x02) entry whose
 * value is the packed snapshot. A `Map` is used so the field key is encoded as
 * an integer on the wire.
 *
 * @param {Uint8Array} packedTelemetry
 * @returns {Map<number, Uint8Array>}
 */
function makeTelemetryFields(packedTelemetry) {
  return new Map([[0x02, packedTelemetry]]);
}

/** Multiplier converting metres/second to km/h (1 m/s = 3.6 km/h). */
const MS_TO_KMH = 3.6;

/**
 * Builds the packed-sensors object consumed by {@link packTelemetry} from a set
 * of normalised, unit-converted readings.
 *
 * This is the Signal-K-aware glue between raw boat data and the wire-format
 * packers: it decides which Sideband sensors to populate and assembles the
 * `custom` sensor entries for readings that have no native Sideband type
 * (depth, tide, wind, anchor watch, vessel state) — so a Sideband user sees at
 * least the same information the NomadNet index page serves.
 *
 * Absent readings are simply omitted; the result may be `{}` (nothing to send).
 * All numeric inputs are expected already unwrapped from Signal K's `{value}`
 * update wrappers and in the units noted below.
 *
 * @param {object} [readings]
 * @param {number} [readings.latitude]  - Decimal degrees.
 * @param {number} [readings.longitude] - Decimal degrees.
 * @param {number} [readings.altitudeM] - Metres.
 * @param {number} [readings.speedMs]   - Metres per second (SOG).
 * @param {number} [readings.bearingRad]- Radians (true heading/COG).
 * @param {number} [readings.batteryPercent] - 0–100.
 * @param {boolean} [readings.batteryCharging]
 * @param {number} [readings.depthM]        - Metres below surface.
 * @param {number} [readings.tideHeightM]   - Metres.
 * @param {string} [readings.tideState]     - e.g. "rising".
 * @param {number} [readings.windSpeedMs]   - Metres per second.
 * @param {number} [readings.windDirectionRad] - Radians (wind-from bearing).
 * @param {number} [readings.anchorDistanceM]  - Metres from bow.
 * @param {string} [readings.vesselState]   - e.g. "anchored".
 * @param {number} [readings.now]           - Unix seconds for the location.
 * @returns {object} Packed sensor values keyed by name, ready for
 *   {@link packTelemetry}. May be empty.
 */
function buildTelemetrySensors(readings = {}) {
  const r = readings || {};
  const sensors = {};

  if (r.latitude != null && r.longitude != null) {
    const location = packLocation({
      latitude: r.latitude,
      longitude: r.longitude,
      altitude: r.altitudeM,
      speedKmh: r.speedMs != null ? r.speedMs * MS_TO_KMH : undefined,
      bearingDeg:
        r.bearingRad != null ? r.bearingRad * (180 / Math.PI) : undefined,
      lastUpdate: r.now,
    });
    if (location) {
      sensors.location = location;
    }
  }

  if (r.batteryPercent != null) {
    sensors.battery = packBattery({
      chargePercent: r.batteryPercent,
      charging: r.batteryCharging,
    });
  }

  const custom = [];
  if (r.depthM != null) {
    custom.push({
      label: "Depth",
      value: `${round1(r.depthM)} m`,
      icon: "waves",
    });
  }
  if (r.tideHeightM != null || r.tideState) {
    const parts = [];
    if (r.tideHeightM != null) {
      parts.push(`${round1(r.tideHeightM)} m`);
    }
    if (r.tideState) {
      parts.push(String(r.tideState));
    }
    custom.push({
      label: "Tide",
      value: parts.join(", "),
      icon: "waves-arrow-up",
    });
  }
  if (r.windSpeedMs != null || r.windDirectionRad != null) {
    const parts = [];
    if (r.windSpeedMs != null) {
      parts.push(`${Math.round(r.windSpeedMs * 1.9438444924406046)} kn`);
    }
    if (r.windDirectionRad != null) {
      parts.push(
        `from ${Math.round(r.windDirectionRad * (180 / Math.PI))}\u00B0`,
      );
    }
    custom.push({
      label: "Wind",
      value: parts.join(" "),
      icon: "weather-windy",
    });
  }
  if (r.anchorDistanceM != null) {
    custom.push({
      label: "Anchor",
      value: `${round1(r.anchorDistanceM)} m from bow`,
      icon: "anchor",
    });
  }
  if (r.vesselState) {
    custom.push({
      label: "State",
      value: String(r.vesselState),
      icon: "sail-boat",
    });
  }
  if (custom.length) {
    sensors.custom = packCustom(custom);
  }

  return sensors;
}

/**
 * LXMF `FIELD_TELEMETRY` field id (§5.9.1). A single telemetry snapshot is
 * carried in an LXMF message's `fields` map under this integer key. Defined
 * locally (rather than imported from `@reticulum/core`) to keep this module
 * self-contained — the value is fixed by the LXMF spec.
 */
const FIELD_TELEMETRY = 0x02;

/**
 * Rounds to one decimal place (used for human-readable telemetry strings).
 *
 * @param {number} n
 * @returns {number}
 */
function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Inbound: Sideband telemetry *unpackers*
// ---------------------------------------------------------------------------
//
// The packers above build the Sideband `Telemeter.packed()` wire values from
// normalised readings. These unpackers are their exact inverses, turning a
// decoded sensor value back into the same normalised readings so inbound crew
// telemetry can be converted into Signal K updates. Every unpacker tolerates a
// missing/malformed value by returning `null`, so a partially-populated or
// forward-compatible snapshot degrades gracefully instead of throwing.

/**
 * Reads a 4-byte big-endian signed integer out of a `bin` sensor element.
 *
 * @param {Uint8Array} bin
 * @returns {number}
 */
function readI32(bin) {
  return new DataView(bin.buffer, bin.byteOffset, bin.byteLength).getInt32(
    0,
    false,
  );
}

/**
 * Reads a 4-byte big-endian unsigned integer out of a `bin` sensor element.
 *
 * @param {Uint8Array} bin
 * @returns {number}
 */
function readU32(bin) {
  return new DataView(bin.buffer, bin.byteOffset, bin.byteLength).getUint32(
    0,
    false,
  );
}

/**
 * Reads a 2-byte big-endian unsigned integer out of a `bin` sensor element.
 *
 * @param {Uint8Array} bin
 * @returns {number}
 */
function readU16(bin) {
  return new DataView(bin.buffer, bin.byteOffset, bin.byteLength).getUint16(
    0,
    false,
  );
}

/**
 * Unpacks a Sideband `location` sensor wire value back into decimal-degree /
 * human-unit readings — the inverse of {@link packLocation}. Returns `null`
 * unless the array carries at least the six fixed-point integers.
 *
 * @param {Array|null|undefined} packed
 * @returns {{latitude:number, longitude:number, altitudeM:number, speedKmh:number, bearingDeg:number, accuracyM:number, lastUpdate:number|undefined}|null}
 */
function unpackLocation(packed) {
  if (!Array.isArray(packed) || packed.length < 6) {
    return null;
  }
  return {
    latitude: readI32(packed[0]) / 1e6,
    longitude: readI32(packed[1]) / 1e6,
    altitudeM: readI32(packed[2]) / 1e2,
    speedKmh: readU32(packed[3]) / 1e2,
    bearingDeg: readI32(packed[4]) / 1e2,
    accuracyM: readU16(packed[5]) / 1e2,
    lastUpdate: packed.length > 6 ? packed[6] : undefined,
  };
}

/**
 * Unpacks a Sideband `battery` sensor wire value
 * `[charge_percent, charging, temperature]` back into a reading — the inverse
 * of {@link packBattery}. Returns `null` for a missing/empty array.
 *
 * @param {Array|null|undefined} packed
 * @returns {{chargePercent:number, charging:boolean, temperature:number|null}|null}
 */
function unpackBattery(packed) {
  if (!Array.isArray(packed) || packed.length === 0) {
    return null;
  }
  return {
    chargePercent: packed[0],
    charging: packed[1] === true,
    temperature: packed.length > 2 ? packed[2] : null,
  };
}

/**
 * Unpacks a Sideband `custom` sensor wire value
 * `[[label, [value, icon]], ...]` back into entries — the inverse of
 * {@link packCustom}. Malformed entries are dropped.
 *
 * @param {Array|null|undefined} packed
 * @returns {Array<{label:string|null, value:*, icon:*}>}
 */
function unpackCustom(packed) {
  if (!Array.isArray(packed)) {
    return [];
  }
  const result = [];
  for (const entry of packed) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const pair = entry[1];
    if (!Array.isArray(pair)) {
      continue;
    }
    result.push({
      label: typeof entry[0] === "string" ? entry[0] : null,
      value: pair[0],
      icon: pair.length > 1 ? pair[1] : null,
    });
  }
  return result;
}

/**
 * Pulls the raw packed-telemetry bytes out of an LXMF message's `fields`, or
 * `null` when the message carries no telemetry snapshot.
 *
 * A deserialized LXMF message's `fields` is a plain object whose keys are the
 * stringified field ids (MessagePack integer keys come back as `"2"`); a
 * locally-constructed message may instead use a `Map` with integer keys. Both
 * shapes are handled, and a `null`/empty value is treated as absent.
 *
 * @param {Map<number, *>|Record<string, *>|null|undefined} fields
 * @returns {Uint8Array|null}
 */
function extractTelemetryField(fields) {
  if (!fields) {
    return null;
  }
  if (fields instanceof Map) {
    return fields.has(FIELD_TELEMETRY) ? fields.get(FIELD_TELEMETRY) : null;
  }
  const value = fields[FIELD_TELEMETRY];
  return value != null ? value : null;
}

/**
 * Decodes a packed Sideband telemetry snapshot into a normalised readings
 * object keyed by human-readable sensor name — the inbound counterpart of
 * {@link buildTelemetrySensors}.
 *
 * Only the sensors relevant to populating Signal K from a crew member's device
 * are decoded (location, battery, temperature, pressure, humidity, time, plus
 * the freeform `custom`/`information` blobs passed through verbatim). Unknown
 * SIDs are ignored, so a newer client sending extra sensors is harmless.
 * Returns `null` for empty/absent input.
 *
 * @param {Uint8Array|null|undefined} packedTelemetry
 * @returns {{latitude?:number, longitude?:number, altitudeM?:number, speedKmh?:number, bearingDeg?:number, accuracyM?:number, lastUpdate?:number, battery?:{chargePercent:number, charging:boolean, temperature:number|null}, temperatureC?:number, pressureMbar?:number, humidityPercent?:number, information?:string, custom?:Array<{label:string|null, value:*, icon:*}>, time?:number}|null}
 */
function decodeTelemetrySnapshot(packedTelemetry) {
  if (!packedTelemetry) {
    return null;
  }
  const sensors = MsgPack.decode(packedTelemetry);
  const get = (sid) => sensors[String(sid)];
  /** @type {object} */
  const readings = {};

  const location = get(SID.LOCATION);
  if (location) {
    const loc = unpackLocation(location);
    if (loc) {
      Object.assign(readings, loc);
    }
  }

  const battery = get(SID.BATTERY);
  if (battery) {
    const bat = unpackBattery(battery);
    if (bat) {
      readings.battery = bat;
    }
  }

  const temperature = get(SID.TEMPERATURE);
  if (typeof temperature === "number") {
    readings.temperatureC = temperature;
  }

  const pressure = get(SID.PRESSURE);
  if (typeof pressure === "number") {
    readings.pressureMbar = pressure;
  }

  const humidity = get(SID.HUMIDITY);
  if (typeof humidity === "number") {
    readings.humidityPercent = humidity;
  }

  const information = get(SID.INFORMATION);
  if (typeof information === "string") {
    readings.information = information;
  }

  const custom = get(SID.CUSTOM);
  if (Array.isArray(custom)) {
    readings.custom = unpackCustom(custom);
  }

  const time = get(SID.TIME);
  if (typeof time === "number") {
    readings.time = time;
  }

  return readings;
}

module.exports = {
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
  // Inbound (Sideband → readings)
  unpackLocation,
  unpackBattery,
  unpackCustom,
  extractTelemetryField,
  decodeTelemetrySnapshot,
};
