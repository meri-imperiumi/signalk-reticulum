/**
 * Brings up a NomadNet node so the Signal K boat can serve pages on the
 * Reticulum mesh.
 *
 * Creates a `nomadnetwork.node` SINGLE destination (PROTOCOL-SPEC.md §1.2,
 * name_hash `213e6311bcec54ab4fde`), registers a `/page/index.mu` request
 * handler — the default path NomadNet clients fetch (§11.6.1) — over the §11
 * REQUEST/RESPONSE protocol, and announces the destination so peers can
 * discover and browse it from Sideband / NomadNet / MeshChat.
 *
 * The transport classes are injected through {@link deps} (defaulting to the
 * real `@reticulum/core`) so this module can be unit-tested without any network
 * I/O.
 *
 * Page content is produced by {@link renderPage} from a context object the
 * caller supplies via `options.getContext`, evaluated fresh on every request so
 * later steps can add live telemetry without touching the transport wiring.
 *
 * @file nomadnet.js
 */

const RNS = require("@reticulum/core");

/** Injected transport classes; tests swap these for fakes. */
const deps = {
  Destination: RNS.Destination,
  DestType: RNS.DestType,
  Allow: RNS.Allow,
  toHex: RNS.toHex,
};

/** NomadNet node aspect (§1.2). */
const NODE_ASPECT = "nomadnetwork.node";
/** Default page path NomadNet clients fetch (§11.6.1). */
const INDEX_PATH = "/page/index.mu";
/** Heading shown when no vessel name is known yet. */
const UNKNOWN_VESSEL = "Unknown vessel";

/** Multiplier converting metres/second to knots (1 m/s ≈ 1.9438 kn). */
const MS_TO_KNOTS = 1.9438444924406046;
/** Multiplier converting radians to degrees. */
const RAD_TO_DEG = 180 / Math.PI;

/** Section header used for the telemetry block when readings are available. */
const TELEMETRY_SECTION = ">Vessel status";

/**
 * Coerces a Signal K self-path value into a finite number, tolerating plain
 * numbers and `{value}` update wrappers. Returns `undefined` for missing,
 * non-numeric or non-finite values so callers can omit the field.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function readNumber(value) {
  if (value && typeof value === "object" && "value" in value) {
    value = value.value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

/**
 * Renders the navigation.state line as "Vessel is <state>".
 *
 * @param {unknown} state - Value at `navigation.state` (e.g. "anchored").
 * @returns {string} Empty when no state is reported.
 */
function formatVesselState(state) {
  const s = readString(state);
  return s ? `Vessel is ${s}` : "";
}

/**
 * Unwraps a `navigation.position` value into its numeric latitude and
 * longitude, tolerating plain `{latitude, longitude}` objects and
 * `{value: {latitude, longitude}}` update wrappers. Partial values (only one
 * coordinate present) are still returned; `undefined` is returned only when
 * neither coordinate is a finite number.
 *
 * @param {unknown} position
 * @returns {{latitude?: number, longitude?: number}|undefined}
 */
function readPosition(position) {
  if (position && typeof position === "object" && "value" in position) {
    position = position.value;
  }
  if (!position || typeof position !== "object") {
    return undefined;
  }
  const latitude = readNumber(position.latitude);
  const longitude = readNumber(position.longitude);
  if (latitude === undefined && longitude === undefined) {
    return undefined;
  }
  return { latitude, longitude };
}

/**
 * Formats a decimal coordinate as degrees and decimal minutes with a
 * hemisphere suffix — e.g. `60.1234` → `60°07.404' N`. Latitudes use a
 * two-digit degree field and N/S, longitudes a three-digit field and E/W,
 * matching how positions are written on nautical charts.
 *
 * @param {number} deg - Decimal degrees.
 * @param {boolean} isLat - `true` for latitude (N/S), `false` for longitude (E/W).
 * @returns {string}
 */
function formatCoord(deg, isLat) {
  const hemisphere = isLat ? (deg >= 0 ? "N" : "S") : deg >= 0 ? "E" : "W";
  const abs = Math.abs(deg);
  const whole = Math.floor(abs);
  const minutes = (abs - whole) * 60;
  const degWidth = isLat ? 2 : 3;
  const degStr = String(whole).padStart(degWidth, "0");
  const minStr = minutes.toFixed(3).padStart(6, "0");
  return `${degStr}\u00B0${minStr}' ${hemisphere}`;
}

/**
 * Renders the navigation.position as
 * "Position: 60°07.404' N, 021°34.068' E", converting decimal degrees to
 * degrees and decimal minutes. Either coordinate may be absent.
 *
 * @param {unknown} position - Value at `navigation.position`
 *   (`{latitude, longitude}`, optionally `{value}` wrapped).
 * @returns {string} Empty when no position is reported.
 */
function formatPosition(position) {
  const pos = readPosition(position);
  if (!pos) {
    return "";
  }
  const parts = [];
  if (pos.latitude !== undefined) {
    parts.push(formatCoord(pos.latitude, true));
  }
  if (pos.longitude !== undefined) {
    parts.push(formatCoord(pos.longitude, false));
  }
  return parts.length ? `Position: ${parts.join(", ")}` : "";
}

/**
 * Renders the anchor watch distance as "Anchor: 12.5 m from bow".
 *
 * @param {unknown} distance - Value at `navigation.anchor.distanceFromBow` (m).
 * @returns {string} Empty when no distance is reported.
 */
function formatAnchorDistance(distance) {
  const d = readNumber(distance);
  return d === undefined ? "" : `Anchor: ${d.toFixed(1)} m from bow`;
}

/**
 * Renders the water depth as "Depth: 5.2 m below surface".
 *
 * @param {unknown} depth - Value at `environment.depth.belowSurface` (m).
 * @returns {string} Empty when no depth is reported.
 */
function formatDepth(depth) {
  const d = readNumber(depth);
  return d === undefined ? "" : `Depth: ${d.toFixed(1)} m below surface`;
}

/**
 * Renders the tide as "Tide: 1.3 m, rising". Either part may be absent.
 *
 * @param {unknown} height - Value at `environment.tide.heightNow` (m).
 * @param {unknown} state - Value at `environment.tide.state` (e.g. "rising").
 * @returns {string} Empty when neither height nor state is reported.
 */
function formatTide(height, state) {
  const h = readNumber(height);
  const s = readString(state);
  if (h === undefined && !s) {
    return "";
  }
  const parts = [];
  if (h !== undefined) {
    parts.push(`${h.toFixed(1)} m`);
  }
  if (s) {
    parts.push(s);
  }
  return `Tide: ${parts.join(", ")}`;
}

/**
 * Renders the wind as "Wind: 12 kn from 45°", converting m/s → knots and
 * radians → degrees. The direction is the bearing the wind blows *from*, so
 * it is prefixed with "from"; either part may be absent.
 *
 * @param {unknown} speedMs - Value at `environment.wind.speedOverGround` (m/s).
 * @param {unknown} directionRad - Value at `environment.wind.directionTrue` (rad).
 * @returns {string} Empty when neither speed nor direction is reported.
 */
function formatWind(speedMs, directionRad) {
  const speed = readNumber(speedMs);
  const dir = readNumber(directionRad);
  if (speed === undefined && dir === undefined) {
    return "";
  }
  const parts = [];
  if (speed !== undefined) {
    parts.push(`${Math.round(speed * MS_TO_KNOTS)} kn`);
  }
  if (dir !== undefined) {
    parts.push(`from ${Math.round(dir * RAD_TO_DEG)}\u00B0`);
  }
  return `Wind: ${parts.join(" ")}`;
}

/**
 * Renders the house battery as "Battery: 87 %, 2.3 A", converting the state of
 * charge from a 0–1 decimal to a percentage. Either part may be absent.
 *
 * @param {unknown} stateOfCharge - Value at
 *   `electrical.batteries.house.capacity.stateOfCharge` (0–1).
 * @param {unknown} current - Value at `electrical.batteries.house.current` (A).
 * @returns {string} Empty when neither charge nor current is reported.
 */
function formatBattery(stateOfCharge, current) {
  const soc = readNumber(stateOfCharge);
  const cur = readNumber(current);
  if (soc === undefined && cur === undefined) {
    return "";
  }
  const parts = [];
  if (soc !== undefined) {
    parts.push(`${Math.round(soc * 100)} %`);
  }
  if (cur !== undefined) {
    parts.push(`${cur.toFixed(1)} A`);
  }
  return `Battery: ${parts.join(", ")}`;
}

/**
 * Renders the `/page/index.mu` micron page for the given context.
 *
 * The page starts with a banner: a configurable ASCII/micron banner when
 * `context.banner` is set, otherwise the vessel name as a micron heading (a
 * line beginning with `>` is a NomadNet section header). When any telemetry is
 * available a ">Vessel status" section is appended with one plain line per
 * reading (state, position, anchor, depth, tide, wind, battery); absent
 * readings are omitted so the page never shows empty placeholders. When a
 * footer is configured it is appended last, separated by a blank line.
 *
 * The context is evaluated per-request so live values stay current.
 *
 * @param {object} [context]
 * @param {unknown} [context.vesselName] - Value at `vessels.self.name`.
 * @param {unknown} [context.banner] - Optional multi-line ASCII/micron banner.
 * @param {unknown} [context.footer] - Optional multi-line ASCII/micron footer.
 * @param {object} [context.telemetry] - Raw Signal K self-path values. The
 *   `position` key takes the `navigation.position` object
 *   (`{latitude, longitude}`, optionally `{value}` wrapped).
 * @returns {string} Micron markup.
 */
function renderPage(context = {}) {
  const cfg = context || {};
  const lines = [];

  const banner = readString(cfg.banner);
  const name = readString(cfg.vesselName) || UNKNOWN_VESSEL;
  lines.push(banner ? banner : `>>${name}`);

  const tel = cfg.telemetry || {};
  const body = [
    formatVesselState(tel.state),
    formatPosition(tel.position),
    formatAnchorDistance(tel.anchorDistance),
    formatDepth(tel.depth),
    formatTide(tel.tideHeight, tel.tideState),
    formatWind(tel.windSpeed, tel.windDirection),
    formatBattery(tel.batterySoc, tel.batteryCurrent),
  ].filter((line) => line && line.trim() !== "");

  if (body.length) {
    lines.push("");
    lines.push(TELEMETRY_SECTION);
    lines.push(...body);
  }

  const footer = readString(cfg.footer);
  if (footer) {
    lines.push("");
    lines.push(footer);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Formats a NomadNet page-request log line in the same column shape as Signal
 * K's HTTP request log (`METHOD PATH STATUS TIME ms LEN REQUESTER`), prefixed
 * with `NomadNet` so mesh-served pages are never confused with the server's
 * own HTTP traffic in the log.
 *
 * The HTTP-style fields are synthesised because NomadNet's §11
 * REQUEST/RESPONSE carries none of them: `status` is 200 for a served page and
 * 500 for a render failure; `method` is GET for a plain fetch and POST for a
 * NomadNet form submission (see {@link setupNomadNet}); `requester` is the
 * browsing peer's hex identity hash (or `-` when anonymous).
 *
 * @param {object} fields
 * @param {string} fields.method
 * @param {string} fields.path
 * @param {number} fields.status
 * @param {string|number} fields.ms - Elapsed milliseconds.
 * @param {number} fields.bytes - Response body length in bytes.
 * @param {string|null} [fields.requester] - Hex identity hash of the requester.
 * @returns {string}
 */
function formatRequestLog({ method, path, status, ms, bytes, requester }) {
  const who = requester || "-";
  return `NomadNet ${method} ${path} ${status} ${ms} ms ${bytes} ${who}`;
}

/**
 * Reduces a remote Reticulum identity to a greppable label for request logging
 * — its hex identity hash — or `null` when no identity is known (an anonymous
 * or not-yet-identified peer).
 *
 * @param {any} identity
 * @returns {string|null}
 */
function identityLabel(identity) {
  if (!identity) return null;
  const hash = identity.identityHash || identity.hash;
  return hash ? deps.toHex(hash) : null;
}

/**
 * Creates and announces the NomadNet node destination, registers the index page
 * handler, and returns an object exposing the destination hash and a `stop()`
 * teardown.
 *
 * A failure to announce is logged but never thrown: the node stays registered
 * and reachable for anyone who already knows the path (e.g. via a cached path
 * entry).
 *
 * @param {object} rns - A Reticulum instance (owns the transport/interfaces).
 * @param {object} identity - The node's Reticulum identity.
 * @param {object} [options]
 * @param {string} [options.displayName] - Node name announced in app_data
 *   (defaults to "Signal K").
 * @param {number} [options.announceIntervalMs] - When positive, re-announce
 *   the node destination at this cadence (first announce fires immediately)
 *   instead of announcing once.
 * @param {() => {vesselName?: unknown, banner?: unknown, telemetry?: object}}
 *   [options.getContext] - Called on each page request to build the render
 *   context (vessel name, optional banner, raw telemetry values), so the page
 *   stays live.
 * @param {(...args:any[])=>void} [log]
 * @returns {Promise<object>} The NomadNet site handle.
 */
async function setupNomadNet(rns, identity, options = {}, log = () => {}) {
  const cfg = options || {};
  const displayName = readString(cfg.displayName) || "Signal K";
  const getContext =
    typeof cfg.getContext === "function" ? cfg.getContext : () => ({});

  const dest = await deps.Destination.IN(
    NODE_ASPECT,
    deps.DestType.SINGLE,
    identity,
    rns,
  );
  // §4.5: a per-destination app_data override takes precedence over the
  // identity's app_data in the announce, so the NomadNet node can advertise
  // its own name without disturbing the LXMF delivery destination.
  dest.appData = encodeUtf8(displayName);

  rns.transport.bindLocalDestination(dest);
  rns.registerDestination(dest);

  await dest.registerRequestHandler(INDEX_PATH, {
    responseGenerator: async (
      path,
      data,
      _requestId,
      remoteIdentity,
      _requestTime,
    ) => {
      const start = Date.now();
      // NomadNet's §11 REQUEST/RESPONSE has no HTTP method or status code.
      // Mirror the protocol's own data convention to derive them for the log:
      // a null `data` is a plain page fetch (GET), a present `data` is a
      // NomadNet form submission (POST); a served page is 200, a render
      // failure 500.
      const method = data == null ? "GET" : "POST";
      let status = 200;
      let body;
      try {
        body = encodeUtf8(renderPage(getContext()));
      } catch (e) {
        status = 500;
        body = encodeUtf8(`>>Error\n\n${e.message}\n`);
        log(`NomadNet page render failed for ${path}: ${e.message}`);
      }
      const ms = (Date.now() - start).toFixed(3);
      log(
        formatRequestLog({
          method,
          path,
          status,
          ms,
          bytes: body.length,
          requester: identityLabel(remoteIdentity),
        }),
      );
      return body;
    },
    allow: deps.Allow.ALL,
  });

  // Accept incoming Links so page REQUESTs can be served. Without this the
  // destination is only *visible* (announce heard) but never completes the
  // LINKREQUEST/LRPROOF handshake, so every client's link times out before it
  // can fetch /page/index.mu. acceptLink sends the LRPROOF and registers the
  // link with the transport; the Link then dispatches REQUEST packets to the
  // registered request handlers automatically. (Mirrors LXMRouter's
  // propagation-node / delivery-destination wiring.)
  /** @type {((event:any)=>Promise<void>)|null} */
  const onLinkRequest = async (event) => {
    try {
      const link = await dest.acceptLink(
        event && event.detail && event.detail.packet,
      );
      // Inject the compressor so compressed inbound resources can be inflated
      // (harmless when no provider is configured).
      link.bz2 = rns.compressionProvider || undefined;
    } catch (e) {
      log(`Failed to accept NomadNet link: ${e.message}`);
    }
  };
  dest.addEventListener("link_request", onLinkRequest);

  try {
    const intervalMs =
      cfg.announceIntervalMs && cfg.announceIntervalMs > 0
        ? cfg.announceIntervalMs
        : null;
    if (intervalMs) {
      // startAnnouncing fires the first announce immediately and repeats on
      // the interval, so it replaces the one-shot announce entirely.
      dest.startAnnouncing({ intervalMs });
      log(
        `Announced NomadNet node ${deps.toHex(
          dest.destinationHash,
        )} as "${displayName}" (re-announcing every ${
          Math.round((intervalMs / 1000) * 10) / 10
        }s)`,
      );
    } else {
      await dest.announce();
      log(
        `Announced NomadNet node ${deps.toHex(
          dest.destinationHash,
        )} as "${displayName}"`,
      );
    }
  } catch (e) {
    log(`Failed to announce NomadNet node: ${e.message}`);
  }

  return {
    destination: dest,
    destinationHash: dest.destinationHash,
    indexPath: INDEX_PATH,
    /**
     * Deregisters the page handler and removes the destination from the node.
     * Best-effort: per-step failures are swallowed so teardown always completes.
     */
    async stop() {
      try {
        dest.stopAnnouncing();
      } catch {
        /* best effort */
      }
      if (onLinkRequest) {
        try {
          dest.removeEventListener("link_request", onLinkRequest);
        } catch {
          /* best effort */
        }
      }
      try {
        await dest.removeRequestHandler(INDEX_PATH);
      } catch {
        /* best effort */
      }
      try {
        rns.deregisterDestination(dest);
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Coerces a Signal K self-path value (plain string or `{value}` wrapper) into a
 * trimmed string. Mirrors the helper in `displayname.js` without importing it,
 * keeping this module's only Signal K coupling at the `getContext` boundary.
 *
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  if (value && typeof value === "object" && "value" in value) {
    value = value.value;
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

/**
 * UTF-8 encodes a string into a Buffer (a Uint8Array), the shape NomadNet page
 * handlers return and the §11.2 RESPONSE path msgpack-encodes as `bin`.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
function encodeUtf8(str) {
  return Buffer.from(str, "utf8");
}

module.exports = {
  deps,
  NODE_ASPECT,
  INDEX_PATH,
  UNKNOWN_VESSEL,
  MS_TO_KNOTS,
  RAD_TO_DEG,
  TELEMETRY_SECTION,
  setupNomadNet,
  renderPage,
  formatRequestLog,
  readString,
  readNumber,
  readPosition,
  formatVesselState,
  formatPosition,
  formatAnchorDistance,
  formatDepth,
  formatTide,
  formatWind,
  formatBattery,
};
