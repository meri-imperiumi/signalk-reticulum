/**
 * RFed (Reticulum Federation) ship-to-ship telemetry.
 *
 * RFed is a many-to-many *channel* messaging protocol built on top of LXMF,
 * carried by a federation node (see `RFed/SPEC.md`). Unlike the Sideband /
 * Columba crew-device telemetry handled in `inbound.js` — where the snapshot
 * arrives from a third-party LXMF client app in Sideband's wire format — the
 * **sender and receiver of RFed ship telemetry are both Signal K nodes running
 * this plugin**, so the snapshot can use a purpose-built, versioned format
 * instead of Sideband's packed sensors.
 *
 * The snapshot is a MessagePack map carried in the LXMF `FIELD_TELEMETRY`
 * (0x02) field, holding roughly what AIS broadcasts plus basic weather:
 *
 *   - `vessel` — static, AIS-like: name, MMSI, callsign, ship type, draft,
 *     length, beam and a free-text destination.
 *   - `nav`    — dynamic, AIS-like: position, SOG, COG, true heading and the
 *     navigation state.
 *   - `env`    — weather: true wind speed/direction, barometric pressure,
 *     outside temperature and relative humidity.
 *
 * All numeric values travel in Signal K's canonical SI units (m/s, rad, Pa, K,
 * ratio), so no lossy unit conversion happens on the wire.
 *
 * Everything pure (the wire codec, the Signal K value mapping and the delta
 * builder) is free of Reticulum I/O and unit-tested in isolation; only
 * {@link setupRFed} and {@link makeShipTelemetryPublisher} touch the network,
 * through the {@link deps}-injected `RFedClient` so tests can fake it.
 *
 * @file rfed.js
 */

const RNS = require("@reticulum/core");
// LXMF and RFed moved out of the package root in @reticulum/core 0.6 —
// deep-import them by subpath.
const { LXMessage } = require("@reticulum/core/src/lxmf/index.js");
const { RFedClient } = require("@reticulum/core/src/rfed/index.js");
const { FIELD_TELEMETRY } = require("./telemetry");
const { extractTelemetryField } = require("./telemetry");

/** Injected transport classes; tests swap these for fakes. */
const deps = {
  RFedClient,
  LXMessage,
  MsgPack: RNS.MsgPack,
  fromHex: RNS.fromHex,
  toHex: RNS.toHex,
};

/** Wire-format schema version. Bump when the map shape changes incompatibly. */
const SCHEMA_VERSION = 1;

/** Length of a Reticulum destination hash in bytes (16). */
const DESTINATION_HASH_BYTES = 16;

/**
 * Default public RFed channel for Signal K vessels. The RFed spec recommends
 * public channels be prefixed `public.` so they are trivially distinguished
 * from `<hex>.<segments>` private channels; `signalk.vessels` names the
 * subject so any Signal K boat subscribing to it discovers every other.
 */
const DEFAULT_CHANNEL = "public.signalk.vessels";

/** Default re-subscribe cadence (refreshes the cached PoW stamp cost). */
const DEFAULT_SUBSCRIBE_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Resolves the configured channel name, defaulting to the public Signal K
 * vessels channel. An empty/whitespace value falls back to the default; a
 * non-empty value is trimmed as-is (so a private `<hex>.foo` channel works).
 *
 * @param {unknown} raw
 * @returns {string}
 */
function effectiveChannel(raw) {
  if (typeof raw !== "string") {
    return DEFAULT_CHANNEL;
  }
  const name = raw.trim();
  return name || DEFAULT_CHANNEL;
}

/**
 * Returns the number when finite, otherwise `undefined` (so the caller can omit
 * the key). Used while building the wire document to avoid emitting `null`/
 * `NaN` values that would round-trip as noise.
 *
 * @param {unknown} n
 * @returns {number|undefined}
 */
function fin(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Encodes a vessel telemetry snapshot into the versioned wire document
 * (MessagePack map), or `null` when there is nothing worth sending (neither
 * static vessel identity nor navigation data is present).
 *
 * Inputs are normalised readings in Signal K canonical units (decimal degrees,
 * m/s, rad, Pa, K, ratio, metres); absent readings are simply omitted.
 *
 * @param {object} [readings]
 * @returns {Uint8Array|null}
 */
function encodeShipTelemetry(readings) {
  const r = readings || {};
  /** @type {Record<string, any>} */
  const doc = {
    v: SCHEMA_VERSION,
    ts: Math.floor(Number(r.now) || Math.floor(Date.now() / 1000)),
  };

  const vessel = {};
  if (r.name) vessel.name = String(r.name);
  if (r.mmsi) vessel.mmsi = String(r.mmsi);
  if (r.callsign) vessel.callsign = String(r.callsign);
  if (Number.isFinite(r.shipType)) vessel.shipType = Math.trunc(r.shipType);
  if (r.destination) vessel.destination = String(r.destination);
  if (fin(r.draft) != null) vessel.draft = r.draft;
  if (fin(r.length) != null) vessel.length = r.length;
  if (fin(r.beam) != null) vessel.beam = r.beam;
  if (Object.keys(vessel).length) doc.vessel = vessel;

  const nav = {};
  if (fin(r.latitude) != null && fin(r.longitude) != null) {
    nav.lat = r.latitude;
    nav.lon = r.longitude;
  }
  if (fin(r.sog) != null) nav.sog = r.sog;
  if (fin(r.cog) != null) nav.cog = r.cog;
  if (fin(r.heading) != null) nav.heading = r.heading;
  if (r.status) nav.status = String(r.status);
  if (Object.keys(nav).length) doc.nav = nav;

  const env = {};
  if (fin(r.windSpeed) != null) env.windSpeed = r.windSpeed;
  if (fin(r.windDir) != null) env.windDir = r.windDir;
  if (fin(r.pressure) != null) env.pressure = r.pressure;
  if (fin(r.temp) != null) env.temp = r.temp;
  if (fin(r.humidity) != null) env.humidity = r.humidity;
  if (Object.keys(env).length) doc.env = env;

  // Worth publishing only when there is at least a vessel identity or a
  // navigation fix; weather-only snapshots are not useful on their own.
  if (!doc.vessel && !doc.nav) {
    return null;
  }
  return deps.MsgPack.encode(doc);
}

/**
 * Decodes a wire document back into the raw map, or `null` for absent /
 * malformed input. Forward-compatible: a future schema version's extra keys
 * are carried through unchanged (callers pick the keys they understand), and
 * an unknown top-level shape degrades to `null`.
 *
 * @param {Uint8Array|null|undefined} bytes
 * @returns {Record<string, any>|null}
 */
function decodeShipTelemetry(bytes) {
  if (!bytes) {
    return null;
  }
  let doc;
  try {
    doc = deps.MsgPack.decode(bytes);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return null;
  }
  return doc;
}

/**
 * Converts a decoded wire document into Signal K `{path, value}` entries in
 * canonical units. Because the wire carries SI units directly, this is a
 * straight path mapping — no unit arithmetic. Absent/invalid fields are
 * skipped, so a snapshot carrying only position yields only the navigation
 * paths.
 *
 * @param {Record<string, any>} doc
 * @returns {Array<{path:string, value:*}>}
 */
function shipTelemetryToValues(doc) {
  const values = [];
  if (!doc || typeof doc !== "object") {
    return values;
  }

  const v = doc.vessel || {};
  if (v.mmsi != null) values.push({ path: "mmsi", value: String(v.mmsi) });
  if (v.callsign) {
    values.push({
      path: "communication.callsignVhf",
      value: String(v.callsign),
    });
  }
  if (Number.isFinite(v.shipType)) {
    values.push({
      path: "design.aisShipType",
      value: { id: Math.trunc(v.shipType) },
    });
  }
  if (v.destination) {
    values.push({
      path: "navigation.destination.commonName",
      value: String(v.destination),
    });
  }
  if (fin(v.draft) != null) {
    values.push({ path: "design.draft.maximum", value: v.draft });
  }
  if (fin(v.length) != null) {
    values.push({ path: "design.length.overall", value: v.length });
  }
  if (fin(v.beam) != null) {
    values.push({ path: "design.beam", value: v.beam });
  }

  const n = doc.nav || {};
  if (fin(n.lat) != null && fin(n.lon) != null) {
    values.push({
      path: "navigation.position",
      value: { latitude: n.lat, longitude: n.lon },
    });
  }
  if (fin(n.sog) != null) {
    values.push({ path: "navigation.speedOverGround", value: n.sog });
  }
  if (fin(n.cog) != null) {
    values.push({ path: "navigation.courseOverGroundTrue", value: n.cog });
  }
  if (fin(n.heading) != null) {
    values.push({ path: "navigation.headingTrue", value: n.heading });
  }
  if (n.status) {
    values.push({ path: "navigation.state", value: String(n.status) });
  }

  const e = doc.env || {};
  if (fin(e.windSpeed) != null) {
    values.push({ path: "environment.wind.speedTrue", value: e.windSpeed });
  }
  if (fin(e.windDir) != null) {
    values.push({
      path: "environment.wind.directionTrue",
      value: e.windDir,
    });
  }
  if (fin(e.pressure) != null) {
    values.push({ path: "environment.outside.pressure", value: e.pressure });
  }
  if (fin(e.temp) != null) {
    values.push({
      path: "environment.outside.temperature",
      value: e.temp,
    });
  }
  if (fin(e.humidity) != null) {
    values.push({
      path: "environment.outside.relativeHumidity",
      value: e.humidity,
    });
  }

  return values;
}

/**
 * Builds the full Signal K delta (context + update) for one received ship
 * telemetry message, ready to pass to `app.handleMessage`.
 *
 * The vessel is keyed by its **MMSI** when the snapshot carries one
 * (`vessels.urn:mrn:imo:mmsi:<mmsi>` — Signal K's standard AIS vessel URN),
 * so a boat heard over the mesh merges with / overlays its real AIS target
 * instead of appearing as a duplicate. A snapshot with no MMSI falls back to
 * the sender's Reticulum identity hash (`vessels.urn:reticulum:identity:<hash>`),
 * so an unregistered boat still shows up as a distinct target. In both cases
 * the context is **never** `vessels.self`; the node's own published echo is
 * dropped outright by {@link handleInboundShipTelemetry} (compared by sender
 * identity hash), so received RFed telemetry can only ever update *other*
 * vessels. The update's `timestamp` is taken from the LXMF message's own send
 * time (not "now"), because an RFed snapshot may have crossed the mesh for
 * hours through store-and-forward and a fresher reading (e.g. real AIS)
 * should win in Signal K's source arbitration.
 *
 * A message whose signature did **not** validate is dropped outright (`null`),
 * so a forged sender public key can't inject a vessel target into Signal K on a
 * public channel. Returns `null` when the message carries no telemetry, the
 * sender identity is unknown, or the snapshot yields no Signal K values.
 *
 * @param {{message?:{timestamp?:number, fields?:Map<number, *>|Record<string, *>}, senderIdentity?:{identityHash?:Uint8Array}|null, sourceHash?:Uint8Array|null, signatureValid?:boolean}|null|undefined} rfedMessage
 * @returns {{context:string, name:string, updates:Array}|null}
 */
function buildShipTelemetryDelta(rfedMessage) {
  if (!rfedMessage) {
    return null;
  }
  // Reject unsigned/forged messages on the public channel.
  if (rfedMessage.signatureValid === false) {
    return null;
  }
  const message = rfedMessage.message;
  const doc = decodeShipTelemetry(
    extractTelemetryField(message && message.fields),
  );
  if (!doc) {
    return null;
  }
  const identityHashBytes =
    rfedMessage.senderIdentity && rfedMessage.senderIdentity.identityHash;
  if (!identityHashBytes) {
    return null;
  }
  const identityHex = deps.toHex(identityHashBytes);
  const mmsi = doc.vessel && doc.vessel.mmsi ? String(doc.vessel.mmsi) : null;
  // Prefer the MMSI-keyed context (Signal K's standard AIS vessel URN) so a
  // boat heard over the mesh merges with its real AIS target; fall back to
  // the identity-hash context when no MMSI is available. Either way this is
  // never vessels.self — the node's own echo is dropped by the orchestrator.
  const context = mmsi
    ? `vessels.urn:mrn:imo:mmsi:${mmsi}`
    : `vessels.urn:reticulum:identity:${identityHex}`;

  const values = shipTelemetryToValues(doc);
  if (values.length === 0) {
    return null;
  }

  const name = doc.vessel && doc.vessel.name;
  if (name) {
    values.push({ path: "", value: { name: String(name) } });
  }
  values.push({
    path: "communication.reticulum.identityHash",
    value: identityHex,
  });
  if (rfedMessage.sourceHash) {
    values.push({
      path: "communication.reticulum.lxmfDestination",
      value: deps.toHex(rfedMessage.sourceHash),
    });
  }

  // Stamp the update with the message's own send time so a stale store-and-
  // forward snapshot never overrides a fresher reading from another source.
  const ts = message && Number(message.timestamp);
  const timestamp = Number.isFinite(ts)
    ? new Date(ts * 1000).toISOString()
    : new Date().toISOString();

  return {
    context,
    name: name ? String(name) : mmsi || identityHex,
    updates: [
      {
        source: { label: "signalk-reticulum", src: identityHex },
        timestamp,
        values,
      },
    ],
  };
}

/**
 * Handles an inbound RFed ship telemetry message, decoding it and pushing the
 * resulting Signal K delta. Returns `true` when a delta was published.
 *
 * Gated by the `rfed.receive_telemetry` setting (off by default). Every signed message
 * on the subscribed channel is accepted — RFed is a public, many-to-many
 * channel, so any publishing boat is a legitimate vessel target (there is no
 * crew-style allow list). Unsigned/forged messages are dropped. The node's
 * own published echo is dropped too: when `selfIdentityHashHex` is supplied
 * and the sender's identity hash matches it, the message is ignored — this is
 * the strict guarantee that received RFed telemetry only ever updates *other*
 * vessels, never `vessels.self` (an MMSI-keyed context for our own MMSI would
 * alias self). A message from *another* publisher that nonetheless claims our
 * own MMSI is dropped too, so a spoofed/colliding MMSI can't redirect a
 * foreign vessel's readings onto us. Per-message failures are logged through
 * `app.debug` and never thrown.
 *
 * @param {{message?:{timestamp?:number, fields?:Map<number, *>|Record<string, *>}, senderIdentity?:{identityHash?:Uint8Array}|null, sourceHash?:Uint8Array|null, signatureValid?:boolean}|null|undefined} message
 * @param {{rfed?:{receive?:boolean}}|null|undefined} settings
 * @param {{handleMessage?:(id:string, delta:object)=>void, debug?:(...args:any[])=>void}|null|undefined} app
 * @param {string} [selfIdentityHashHex] - This node's own identity hash; a
 *   message whose sender identity matches it is ignored as a self-echo.
 * @param {string} [selfMmsi] - This node's own MMSI; a message whose snapshot
 *   carries it is ignored, so another publisher can't claim our MMSI.
 * @returns {boolean}
 */
function handleInboundShipTelemetry(
  message,
  settings,
  app,
  selfIdentityHashHex,
  selfMmsi,
) {
  const debug =
    app && typeof app.debug === "function" ? (msg) => app.debug(msg) : () => {};
  const error =
    app && typeof app.error === "function" ? (msg) => app.error(msg) : () => {};
  if (!message) {
    return false;
  }
  if (!settings || !settings.rfed || !settings.rfed.receive_telemetry) {
    return false;
  }
  if (message.signatureValid === false) {
    debug("Dropping inbound RFed ship telemetry: signature invalid");
    return false;
  }
  // Strict self-guard: never let the node's own published echo update Signal
  // K — an MMSI-keyed context for our own MMSI would alias vessels.self.
  const senderHashBytes =
    message.senderIdentity && message.senderIdentity.identityHash;
  if (
    selfIdentityHashHex &&
    senderHashBytes &&
    deps.toHex(senderHashBytes) === selfIdentityHashHex
  ) {
    debug("Ignoring own RFed telemetry echo");
    return false;
  }
  const delta = buildShipTelemetryDelta(message);
  if (!delta) {
    return false;
  }
  // A *different* publisher claiming our own MMSI would route its readings
  // onto the MMSI-keyed context that aliases vessels.self — drop it and log
  // the offender's identity so the operator can investigate/allow-list.
  if (selfMmsi && delta.context === `vessels.urn:mrn:imo:mmsi:${selfMmsi}`) {
    const offender =
      senderHashBytes != null ? deps.toHex(senderHashBytes) : "unknown";
    error(
      `RFed ship telemetry from ${offender} claims our own MMSI ` +
        `(${selfMmsi}); dropping to protect vessels.self`,
    );
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
    debug(`Populated ship telemetry for ${delta.name || delta.context}`);
    return true;
  } catch (e) {
    debug(`Failed to populate ship telemetry: ${e.message}`);
    return false;
  }
}

/**
 * Builds an async `publish(packedSnapshot)` callback that wraps the snapshot
 * bytes in an LXMF message (carried in `FIELD_TELEMETRY`, empty title/content)
 * and publishes it to the channel through the given RFed client.
 *
 * The LXMF `sourceHash`/`destinationHash` are left as placeholders because the
 * RFed client's `wrapChannelMessage` overwrites them with the correct
 * channel/sender `lxmf.delivery` hashes before signing — confusing the bare
 * identity hash for the `lxmf.delivery` destination hash is the classic rfed
 * bug (see `RFed/SPEC.md`).
 *
 * @param {object} client - An `RFedClient`.
 * @param {string} nodeHashHex - The federation node's destination hash (hex).
 * @param {string} channel - The channel name to publish on.
 * @returns {(packedTelemetry:Uint8Array)=>Promise<void>}
 */
function makeShipTelemetryPublisher(client, nodeHashHex, channel) {
  return async function publishShipTelemetry(packedTelemetry) {
    if (!client || !packedTelemetry) {
      return;
    }
    const message = new deps.LXMessage({
      // Overwritten by RFed's wrapChannelMessage before signing.
      sourceHash: new Uint8Array(DESTINATION_HASH_BYTES),
      destinationHash: new Uint8Array(DESTINATION_HASH_BYTES),
      title: "",
      content: "",
      fields: new Map([[FIELD_TELEMETRY, packedTelemetry]]),
    });
    await client.publish(deps.fromHex(nodeHashHex), channel, message);
  };
}

/**
 * Periodically pulls deferred messages from the RFed node for a channel.
 * This fetches messages that were deferred (e.g., due to offline subscribers)
 * so they're not lost. The pull continues until no more pending messages.
 *
 * @param {object} client - An `RFedClient`.
 * @param {Uint8Array} nodeHash - The federation node's destination hash.
 * @param {string} channel - The channel name to pull from.
 * @param {(decoded:any)=>void} onMessage - Callback for each pulled message.
 * @param {(...args:any[])=>void} [log]
 */
async function pullDeferredMessages(
  client,
  nodeHash,
  channel,
  onMessage,
  log = () => {},
) {
  if (!client) return;

  let totalPulled = 0;
  try {
    let morePending = true;
    while (morePending) {
      const result = await client.pull(nodeHash, channel);
      for (const item of result.items) {
        try {
          // Decode the pulled blob the same way fanout messages are decoded
          const channelEntry = client._channelByHash(item.channelHash);
          if (!channelEntry) {
            log(`Pulled message for unknown channel`);
            continue;
          }
          const {
            unwrapChannelMessage,
          } = require("@reticulum/core/src/rfed/blob.js");
          const decoded = await unwrapChannelMessage({
            innerBlob: item.blob,
            channelIdentity: channelEntry.identity,
            channelDeliveryHash: channelEntry.deliveryHash,
          });
          onMessage({
            ...decoded,
            channelHash: item.channelHash,
            channelName: channelEntry.name,
          });
          totalPulled++;
        } catch (e) {
          log(`Failed to decode pulled message: ${e.message}`);
        }
      }
      morePending = result.morePending;
    }
    if (totalPulled > 0) {
      log(`Pulled ${totalPulled} deferred message(s) from RFed node`);
    }
  } catch (e) {
    log(`RFed pull failed: ${e.message}`);
  }
}

/**
 * Brings up an RFed channel client against a federation node: starts listening
 * for live fanout deliveries on the node's own `rfed.delivery` destination and
 * subscribes to the channel (caching the advertised PoW stamp cost so later
 * publishes are stamped correctly).
 *
 * Subscription is best-effort and retried on a timer: the node's identity is
 * only recalled once its announce has been heard, so a subscribe fired before
 * that resolves fails harmlessly and the next retry (or a later publish that
 * re-subscribes) picks it up. Re-subscribing also refreshes the cached stamp
 * cost, which the RFed spec recommends doing at least once per session.
 *
 * @param {object} rns - A Reticulum instance.
 * @param {object} identity - This node's Reticulum identity.
 * @param {{nodeHashHex:string, channel:string, subscribeIntervalMs?:number, announceIntervalMs?:number}} options
 *   `announceIntervalMs` re-announces the `rfed.delivery` destination at that
 *   cadence (first announce already fired in `listen()`), keeping the
 *   federation node's subscriber presence fresh and cached mesh paths alive
 *   (PROTOCOL-SPEC.md §7.5 / §9.7); 0/absent falls back to the single
 *   announce `listen()` did.
 * @param {(decoded:any)=>void} onMessage - Callback for each decoded fanout message.
 * @param {(...args:any[])=>void} [log]
 * @returns {Promise<{client:object, deliveryHashHex:string, teardown:()=>void}>}
 */
async function setupRFed(rns, identity, options, onMessage, log) {
  const debug = typeof log === "function" ? log : () => {};
  const nodeHashHex = options && options.nodeHashHex;
  const channel = options && options.channel;
  if (!nodeHashHex || !channel) {
    throw new Error("setupRFed requires nodeHashHex and channel");
  }
  const client = new deps.RFedClient({ identity, rns });
  const nodeHash = deps.fromHex(nodeHashHex);

  // Announce our rfed.delivery destination and start receiving fanout.
  let deliveryHashHex = "";
  let deliveryDest = null;
  try {
    const deliveryHash = await client.listen(onMessage);
    deliveryHashHex = deps.toHex(deliveryHash);
    // `rfed.delivery` is a bare subscriber-delivery endpoint: it must not
    // advertise the LXMF announce app_data that sharing an identity with the
    // LXMRouter otherwise leaves on `identity.appData` (and which
    // `Destination._emitAnnounce` falls back to when no per-destination
    // override is set). Clear it so subsequent re-announces carry no
    // app_data, matching a standalone RFed client. (The one announce
    // `listen()` already broadcast is replaced on the next re-announce.)
    deliveryDest = client.deliveryDest || null;
    if (deliveryDest) {
      deliveryDest.appData = new Uint8Array(0);
    }
    debug(`Announced rfed.delivery destination ${deliveryHashHex}`);
  } catch (e) {
    debug(`rfed listen failed: ${e.message}`);
  }

  // Subscribe (best-effort) and re-subscribe periodically to refresh the
  // cached stamp cost and recover from a node-identity-not-yet-known start.
  const subscribeOnce = async () => {
    try {
      const res = await client.subscribe(nodeHash, channel);
      debug(
        `Subscribed to rfed channel "${channel}" on node ${nodeHashHex}` +
          (res && res.stampCost != null
            ? ` (stamp cost ${res.stampCost})`
            : ""),
      );
      return true;
    } catch (e) {
      debug(
        `rfed subscribe to "${channel}" on ${nodeHashHex} failed: ${e.message}`,
      );
      return false;
    }
  };
  subscribeOnce().catch(() => {});
  const intervalMs =
    options.subscribeIntervalMs && options.subscribeIntervalMs > 0
      ? options.subscribeIntervalMs
      : DEFAULT_SUBSCRIBE_INTERVAL_MS;
  const timer = setInterval(() => {
    subscribeOnce().catch(() => {});
  }, intervalMs);

  // Periodically re-announce rfed.delivery so the federation node keeps
  // treating us as a live subscriber (presence TTL) and so cached mesh paths
  // to it stay fresh — the same rationale as the LXMF / NomadNet re-announce
  // loops. Without this, a transit relay evicts the path within minutes and
  // the node can no longer route live fanout to us. 0/absent keeps the single
  // announce `listen()` already did.
  let announceTimer = null;
  if (
    options.announceIntervalMs &&
    options.announceIntervalMs > 0 &&
    deliveryDest
  ) {
    announceTimer = setInterval(() => {
      Promise.resolve(deliveryDest.announce()).catch((e) =>
        debug(`rfed.delivery re-announce failed: ${e.message}`),
      );
    }, options.announceIntervalMs);
  }

  return {
    client,
    deliveryHashHex,
    teardown: () => {
      clearInterval(timer);
      if (announceTimer) clearInterval(announceTimer);
    },
  };
}

/**
 * Builds an async `publish(packedSnapshot)` that publishes own telemetry to the
 * channel by ingesting directly into the embedded RFed node (in-process).
 *
 * When the plugin runs its own RFed federation node, the node and its client
 * share one Reticulum instance and identity. A link-based `RFedClient` cannot
 * reach a destination in the same process — a local announce is never
 * ingested (so the node's identity is never recallable) and an outbound
 * packet to a local destination has no path — so the local transmitter feeds
 * the node's ingest directly instead.
 *
 * The snapshot is wrapped with the canonical `wrapChannelMessage` codec
 * (EC-encrypted to the channel identity, RTID-preluded, LXMF-signed) —
 * identical bytes to what a remote `RFedClient.publish` puts on the wire — then
 * handed to `node._ingest`, which stores the blob (so it shows up in
 * `rfedBlobsStored`) and fans it out to *remote* subscribers over the mesh.
 * The embedded node therefore looks and behaves like a regular federation
 * node to everything outside. The local publish skips PoW stamp validation
 * (the operator trusts their own node); remote publishers still must stamp.
 *
 * @param {object} node - An `RFedNode` (the embedded federation node).
 * @param {object} senderIdentity - This node's Reticulum identity (signs + EC).
 * @param {string} channel - The channel name to publish on.
 * @returns {(packedTelemetry:Uint8Array)=>Promise<void>}
 */
function makeEmbeddedShipTelemetryPublisher(node, senderIdentity, channel) {
  return async function publishShipTelemetry(packedTelemetry) {
    if (!node || !packedTelemetry) {
      return;
    }
    const {
      deriveChannel,
      deliveryHashFor,
    } = require("@reticulum/core/src/rfed/channel.js");
    const { wrapChannelMessage } = require("@reticulum/core/src/rfed/blob.js");
    const { identity: channelIdentity, channelHash } =
      await deriveChannel(channel);
    const senderLxmDeliveryHash = await deliveryHashFor(senderIdentity);
    const message = new deps.LXMessage({
      // Overwritten by RFed's wrapChannelMessage before signing.
      sourceHash: new Uint8Array(DESTINATION_HASH_BYTES),
      destinationHash: new Uint8Array(DESTINATION_HASH_BYTES),
      title: "",
      content: "",
      fields: new Map([[FIELD_TELEMETRY, packedTelemetry]]),
    });
    const { innerBlob } = await wrapChannelMessage({
      channelIdentity,
      senderIdentity,
      senderLxmDeliveryHash,
      lxmMessage: message,
      // The local publish is trusted (the operator owns this node); a stamp
      // is never validated on the direct-ingest path, so none is generated.
      stampCost: null,
    });
    await node._ingest(channelHash, innerBlob);
  };
}

/**
 * Wires an in-process RFed client to the embedded federation node so received
 * channel messages reach the telemetry handler without a link.
 *
 * Taps the node's fanout: every blob the node ingests — whether published live
 * by a remote boat over the mesh, pulled in by peer sync, or originated by
 * this node's own transmitter — is decoded with the canonical
 * `unwrapChannelMessage` codec and passed to `onMessage` with the same shape a
 * link-based `RFedClient` produces. Only the configured channel is decoded
 * (blobs for other channels are skipped); the node's own published echo is
 * dropped by the existing self-identity guard in
 * {@link handleInboundShipTelemetry} (the next layer up), matching how the
 * remote path handles its own echo.
 *
 * This is the receive-side counterpart to {@link makeEmbeddedShipTelemetryPublisher}
 * and exists because a link-based `RFedClient` cannot reach a destination in
 * the same Reticulum process (see {@link makeEmbeddedShipTelemetryPublisher}'s
 * rationale). The embedded node stays a normal federation node to everything
 * outside: remote boats subscribe and publish via links exactly as they would
 * to any rfed node.
 *
 * @param {object} node - An `RFedNode` (the embedded federation node).
 * @param {string} channel - The channel name to decode.
 * @param {(decoded:any)=>void} onMessage - Callback for each decoded message.
 * @param {(...args:any[])=>void} [log]
 * @returns {Promise<{teardown:()=>void}>}
 */
async function setupEmbeddedRFedClient(node, channel, onMessage, log) {
  const debug = typeof log === "function" ? log : () => {};
  if (!node) {
    return { teardown: () => {} };
  }
  const {
    deriveChannel,
    deliveryHashFor,
  } = require("@reticulum/core/src/rfed/channel.js");
  const { unwrapChannelMessage } = require("@reticulum/core/src/rfed/blob.js");
  const { identity: channelIdentity, channelHash: expectedChannelHash } =
    await deriveChannel(channel);
  const channelDeliveryHash = await deliveryHashFor(channelIdentity);
  const expectedChannelHex = deps.toHex(expectedChannelHash);

  const originalFanout = node._fanout.bind(node);
  node._fanout = async (channelHash, innerBlob) => {
    await originalFanout(channelHash, innerBlob);
    // Decode and dispatch to the telemetry handler. The node's own echo is
    // dropped downstream by the self-identity guard; a malformed/foreign
    // blob is logged and never throws.
    try {
      if (!channelHash || channelHash.length !== DESTINATION_HASH_BYTES) {
        return;
      }
      if (deps.toHex(channelHash) !== expectedChannelHex) {
        return;
      }
      const decoded = await unwrapChannelMessage({
        innerBlob,
        channelIdentity,
        channelDeliveryHash,
      });
      onMessage({
        ...decoded,
        channelHash: new Uint8Array(channelHash),
        channelName: channel,
      });
    } catch (e) {
      debug(`Embedded RFed receive decode error: ${e.message}`);
    }
  };

  return {
    teardown: () => {
      // Remove the own property so the prototype method is used again.
      delete node._fanout;
    },
  };
}

module.exports = {
  deps,
  SCHEMA_VERSION,
  DEFAULT_CHANNEL,
  DEFAULT_SUBSCRIBE_INTERVAL_MS,
  effectiveChannel,
  encodeShipTelemetry,
  decodeShipTelemetry,
  shipTelemetryToValues,
  buildShipTelemetryDelta,
  handleInboundShipTelemetry,
  makeShipTelemetryPublisher,
  makeEmbeddedShipTelemetryPublisher,
  pullDeferredMessages,
  setupRFed,
  setupEmbeddedRFedClient,
};
