/**
 * Inbound telemetry: turns a Sideband telemetry snapshot arriving over LXMF
 * from a crew member's device into Signal K deltas, so crew positions and
 * environmental readings show up in Signal K (charts, instrument panels) the
 * same way `signalk-meshtastic` populates them from mesh nodes.
 *
 * The wire-format decoding (Sideband packed sensors → readings) lives in
 * `telemetry.js`; this module is the Signal-K-aware glue on top of it:
 *   - resolve which crew member a message came from (by source hash),
 *   - map that to a stable Signal K vessel context,
 *   - convert the readings to Signal K paths with the correct units, and
 *   - push the resulting delta through `app.handleMessage`.
 *
 * Everything here is pure (free of Reticulum I/O) so it can be unit-tested in
 * isolation by passing in a plain `app` that records `handleMessage` calls.
 *
 * @file inbound.js
 */

const { toHex } = require("@reticulum/core");
const {
  normalizeHex,
  IDENTITY_HASH_RE,
  DESTINATION_HASH_RE,
} = require("./notifications");
const { deriveLxmfDestinationHash } = require("./identity");
const {
  extractTelemetryField,
  decodeTelemetrySnapshot,
} = require("./telemetry");

/** Multiplier converting metres/second to km/h (1 m/s = 3.6 km/h). */
const MS_TO_KMH = 3.6;
/** Degrees → radians. */
const DEG_TO_RAD = Math.PI / 180;
/** Celsius → Kelvin offset. */
const KELVIN_OFFSET = 273.15;
/** Length of the short stable id derived from a hash for battery instances. */
const SOURCE_ID_HEX_LEN = 8;

/**
 * Normalises the configured crew list into entries that keep both the protocol
 * identity hash (when configured) and the derived `lxmf.delivery` destination
 * hash, so an inbound message's source hash can be matched back to a crew
 * member and a stable, identity-keyed context built for them.
 *
 * This mirrors {@link effectiveCrew} in `notifications.js` but additionally
 * retains the identity hash, which `effectiveCrew` drops (its callers only need
 * the destination hash). Entries with neither a valid identity nor a legacy
 * `destination` are skipped.
 *
 * @param {unknown} crew
 * @returns {Array<{name:string, identityHash:string|null, destinationHash:string}>}
 */
function crewEntries(crew) {
  if (!Array.isArray(crew)) {
    return [];
  }
  const result = [];
  for (const entry of crew) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const name =
      typeof entry.name === "string" && entry.name ? entry.name : null;

    const identityHash = normalizeHex(entry.identity);
    if (IDENTITY_HASH_RE.test(identityHash)) {
      result.push({
        name: name || identityHash,
        identityHash,
        destinationHash: deriveLxmfDestinationHash(identityHash),
      });
      continue;
    }

    const destinationHash = normalizeHex(entry.destination);
    if (DESTINATION_HASH_RE.test(destinationHash)) {
      result.push({
        name: name || destinationHash,
        identityHash: null,
        destinationHash,
      });
    }
  }
  return result;
}

/**
 * Finds the configured crew member (if any) whose `lxmf.delivery` destination
 * hash matches an inbound message's source hash.
 *
 * The source hash travels on the wire as raw bytes; it is hex-encoded here and
 * compared against each crew entry's derived destination hash (both are
 * lowercase, so the comparison is case-insensitive by construction).
 *
 * @param {Uint8Array|null|undefined} sourceHash
 * @param {unknown} crew
 * @returns {{name:string, identityHash:string|null, destinationHash:string}|null}
 */
function matchCrewBySource(sourceHash, crew) {
  if (!sourceHash) {
    return null;
  }
  const sourceHex = toHex(sourceHash);
  return (
    crewEntries(crew).find((member) => member.destinationHash === sourceHex) ||
    null
  );
}

/**
 * Builds the Signal K vessel context for a crew member.
 *
 * The context is keyed by the crew member's Reticulum identity hash (stable
 * across protocols) when available, falling back to their `lxmf.delivery`
 * destination hash. Using `vessels.urn:reticulum:identity:<hash>` (rather than
 * `vessels.self`) makes the crew member appear as a distinct vessel target in
 * Signal K — on charts (Freeboard) and instrument panels — exactly like an AIS
 * target, so a crew-overboard or a dinghy tracker is visible at a glance.
 *
 * @param {{identityHash:string|null, destinationHash:string}|null} member
 * @returns {string|null}
 */
function crewContext(member) {
  if (!member) {
    return null;
  }
  const key = member.identityHash || member.destinationHash;
  return `vessels.urn:reticulum:identity:${key}`;
}

/**
 * Derives a short, stable battery-instance id from a crew member's hash, so a
 * crew device's battery state of charge lands under a predictable
 * `electrical.batteries.<id>.…` path instead of a 32-char hex slug. The first
 * 8 hex characters are collision-resistant enough for the handful of crew
 * devices on a typical boat.
 *
 * @param {string} hashHex
 * @returns {string}
 */
function sourceInstanceId(hashHex) {
  return (hashHex || "").replace(/[^0-9a-f]/gi, "").slice(0, SOURCE_ID_HEX_LEN);
}

/**
 * Converts a decoded telemetry snapshot into Signal K `{path, value}` entries
 * with the correct units, scoped under a per-crew battery instance id.
 *
 * Mirrors the units the outbound {@link buildTelemetrySensors} packs from, in
 * reverse: km/h → m/s, deg → rad, % → ratio, °C → K, mbar → Pa. Only present,
 * finite readings produce values; a snapshot with just a location yields just
 * the navigation paths.
 *
 * @param {object} readings - Output of {@link decodeTelemetrySnapshot}.
 * @param {string} batteryInstance - Battery instance id for this crew member.
 * @returns {Array<{path:string, value:*}>}
 */
function telemetryToValues(readings, batteryInstance) {
  const values = [];

  if (
    Number.isFinite(readings.latitude) &&
    Number.isFinite(readings.longitude)
  ) {
    values.push({
      path: "navigation.position",
      value: {
        latitude: readings.latitude,
        longitude: readings.longitude,
      },
    });
  }
  if (Number.isFinite(readings.speedKmh)) {
    values.push({
      path: "navigation.speedOverGround",
      value: readings.speedKmh / MS_TO_KMH,
    });
  }
  if (Number.isFinite(readings.bearingDeg)) {
    values.push({
      path: "navigation.courseOverGroundTrue",
      value: readings.bearingDeg * DEG_TO_RAD,
    });
  }
  if (Number.isFinite(readings.altitudeM)) {
    values.push({
      path: "navigation.gnss.antennaAltitude",
      value: readings.altitudeM,
    });
  }

  if (readings.battery && Number.isFinite(readings.battery.chargePercent)) {
    values.push({
      path: `electrical.batteries.${batteryInstance}.capacity.stateOfCharge`,
      value: readings.battery.chargePercent / 100,
    });
  }

  if (Number.isFinite(readings.temperatureC)) {
    values.push({
      path: "environment.outside.temperature",
      value: readings.temperatureC + KELVIN_OFFSET,
    });
  }
  if (Number.isFinite(readings.pressureMbar)) {
    values.push({
      path: "environment.outside.pressure",
      value: readings.pressureMbar * 100,
    });
  }
  if (Number.isFinite(readings.humidityPercent)) {
    values.push({
      path: "environment.outside.relativeHumidity",
      value: readings.humidityPercent / 100,
    });
  }

  return values;
}

/**
 * Builds the full Signal K delta (context + update) for a crew member's
 * telemetry snapshot, ready to pass to `app.handleMessage`.
 *
 * Alongside the sensor values, the crew member's name is injected (via an empty
 * path) so the vessel target renders with a readable label, and their
 * Reticulum identity / LXMF destination are recorded under
 * `communication.reticulum.*` for traceability. Returns `null` when the sender
 * is not a configured crew member, when the message carries no telemetry, or
 * when the telemetry yields no Signal K values — inbound telemetry is
 * currently populated for configured crew only.
 *
 * @param {Uint8Array} sourceHash - The inbound message's source hash.
 * @param {Map<number, *>|Record<string, *>|null|undefined} fields - The LXMF
 *   message's `fields` (the telemetry snapshot is extracted from here).
 * @param {unknown} crew - The configured crew list.
 * @returns {{context:string, updates:Array, name:string}|null}
 */
function buildCrewTelemetryDelta(sourceHash, fields, crew) {
  const member = matchCrewBySource(sourceHash, crew);
  const context = crewContext(member);
  if (!context) {
    return null;
  }
  const identityKey = member.identityHash || member.destinationHash;
  const readings = decodeTelemetrySnapshot(extractTelemetryField(fields));
  if (!readings) {
    return null;
  }
  const batteryInstance = sourceInstanceId(identityKey);
  const values = telemetryToValues(readings, batteryInstance);
  if (values.length === 0) {
    return null;
  }
  values.push({ path: "", value: { name: member.name } });
  values.push({
    path: "communication.reticulum.identityHash",
    value: identityKey,
  });
  values.push({
    path: "communication.reticulum.lxmfDestination",
    value: toHex(sourceHash),
  });
  return {
    context,
    name: member.name,
    updates: [
      {
        source: {
          label: "signalk-reticulum",
          src: toHex(sourceHash),
        },
        timestamp: new Date().toISOString(),
        values,
      },
    ],
  };
}

/**
 * Publishes Signal K metadata for the paths inbound crew telemetry writes to,
 * so instruments display them with the right units and labels. Idempotent: the
 * server merges meta, so calling it once per start is enough.
 *
 * @param {{handleMessage?:(id:string, delta:object)=>void}|null|undefined} app
 */
function sendInboundTelemetryMeta(app) {
  if (!app || typeof app.handleMessage !== "function") {
    return;
  }
  app.handleMessage("signalk-reticulum", {
    updates: [
      {
        meta: [
          {
            path: "communication.reticulum.identityHash",
            value: {
              displayName: "Reticulum identity",
              description:
                "The crew member's protocol-agnostic Reticulum identity hash.",
            },
          },
          {
            path: "communication.reticulum.lxmfDestination",
            value: {
              displayName: "LXMF destination",
              description:
                "The crew member's lxmf.delivery destination hash the telemetry arrived from.",
            },
          },
        ],
      },
    ],
  });
}

/**
 * Handles an inbound LXMF message that may carry a telemetry snapshot,
 * decoding it and pushing the resulting Signal K delta for a configured crew
 * member. Returns `true` when a telemetry delta was published.
 *
 * Gated by the `telemetry.populate_crew_telemetry` setting (off by default), so
 * populating Signal K vessel targets from the mesh is opt-in. Telemetry is only
 * accepted from **configured crew members**: a snapshot from any other sender
 * is dropped (with a debug log) so an unknown peer can't inject vessel targets
 * into Signal K. Other related sources (dinghy trackers, nearby boats, …) will
 * be added later as explicit, allow-listed cases. Telemetry messages carry no
 * command text, so this is safe to run alongside the command handler (which
 * will simply find no matching command). Per-message failures are logged
 * through `app.debug` and never thrown.
 *
 * @param {{sourceHash?:Uint8Array, fields?:Map<number, *>|Record<string, *>}|null|undefined} message
 * @param {{telemetry?:{populate_crew_telemetry?:boolean}, crew?:unknown}|null|undefined} settings
 * @param {{handleMessage?:(id:string, delta:object)=>void, debug?:(...args:any[])=>void}|null|undefined} app
 * @returns {boolean}
 */
function handleInboundTelemetry(message, settings, app) {
  const debug =
    app && typeof app.debug === "function" ? (msg) => app.debug(msg) : () => {};
  if (!message || !message.sourceHash) {
    return false;
  }
  if (
    !settings ||
    !settings.telemetry ||
    !settings.telemetry.populate_crew_telemetry
  ) {
    return false;
  }
  if (!extractTelemetryField(message.fields)) {
    return false;
  }
  // Crew-only: drop telemetry from any sender that isn't a configured crew
  // member, so an unknown peer can't inject vessel targets into Signal K.
  const member = matchCrewBySource(message.sourceHash, settings.crew);
  if (!member) {
    debug(
      `Dropping inbound telemetry from ${toHex(
        message.sourceHash,
      )}: sender is not a configured crew member`,
    );
    return false;
  }
  const delta = buildCrewTelemetryDelta(
    message.sourceHash,
    message.fields,
    settings.crew,
  );
  if (!delta) {
    return false;
  }
  if (!app || typeof app.handleMessage !== "function") {
    return false;
  }
  try {
    app.handleMessage("signalk-reticulum", {
      context: delta.context,
      updates: delta.updates,
    });
    debug(`Populated crew telemetry for ${delta.name} into ${delta.context}`);
    return true;
  } catch (e) {
    debug(`Failed to populate crew telemetry: ${e.message}`);
    return false;
  }
}

module.exports = {
  MS_TO_KMH,
  DEG_TO_RAD,
  KELVIN_OFFSET,
  crewEntries,
  matchCrewBySource,
  crewContext,
  sourceInstanceId,
  telemetryToValues,
  buildCrewTelemetryDelta,
  sendInboundTelemetryMeta,
  handleInboundTelemetry,
};
