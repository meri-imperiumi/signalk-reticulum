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
/** Path of the passage-briefing page served beside the index. */
const BRIEFING_PATH = "/page/briefing.mu";
/** Heading shown when no vessel name is known yet. */
const UNKNOWN_VESSEL = "Unknown vessel";

/** Multiplier converting metres/second to knots (1 m/s ≈ 1.9438 kn). */
const MS_TO_KNOTS = 1.9438444924406046;
/** Multiplier converting radians to degrees. */
const RAD_TO_DEG = 180 / Math.PI;

/** Section header used for the telemetry block when readings are available. */
const TELEMETRY_SECTION = ">Vessel status";

/**
 * The signalk-energy-predictor plugin publishes its overall 24 hour energy
 * outlook here as a plain string: "surplus", "rising", "stable", "deficit"
 * or "critical".
 */
const ENERGY_OUTLOOK_PATH = "electrical.energy.prediction.status";
/**
 * The signalk-status-tiles plugin publishes each tile's aggregated state as a
 * plain string under this branch, one path per tile id.
 */
const TILE_STATUS_BASE = "statusTiles.tiles";

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
 * The energy predictor's overall outlook describes the same house bank, so
 * when available it rides along at the end of the line as
 * "Battery: 87 %, 2.3 A, surplus" (or rising, stable, deficit, critical).
 * Without charge or current there is nowhere natural to put the term, so it
 * is left out — mirroring the `signalk-meshtastic` status command.
 *
 * @param {unknown} stateOfCharge - Value at
 *   `electrical.batteries.house.capacity.stateOfCharge` (0–1).
 * @param {unknown} current - Value at `electrical.batteries.house.current` (A).
 * @param {unknown} outlook - Value at `electrical.energy.prediction.status`,
 *   already normalized to a plain non-empty string (or empty when absent).
 * @returns {string} Empty when neither charge nor current is reported.
 */
function formatBattery(stateOfCharge, current, outlook) {
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
  if (outlook) {
    parts.push(outlook);
  }
  return `Battery: ${parts.join(", ")}`;
}

/**
 * Unwraps a Signal K leaf node — a plain value or a `{value}` update wrapper —
 * to its raw value. Used for the tile subtree, where each tile id maps to
 * either shape depending on the server.
 *
 * @param {unknown} node
 * @returns {unknown}
 */
function leafValue(node) {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (typeof node === "object" && "value" in node) {
    return node.value;
  }
  return node;
}

/**
 * Reads the status tile subtree into `{id, state}` pairs, keeping only tiles
 * that report a plain string state.
 *
 * Tile states are change-driven publications, so a green tile may not have
 * sent anything in a long time. That is fine: green means nothing needs
 * attention, and there is nothing to go stale about that.
 *
 * Tile labels live in the tiles configuration, not on the bus, so tiles are
 * named by id.
 *
 * @param {unknown} tiles - Value at `statusTiles.tiles` (the subtree of leaf
 *   nodes `getSelfPath` returns for an intermediate path).
 * @returns {{id: string, state: string}[]}
 */
function tileStatuses(tiles) {
  if (!tiles || typeof tiles !== "object" || Array.isArray(tiles)) {
    return [];
  }
  return Object.keys(tiles)
    .map((id) => ({ id, state: leafValue(tiles[id]) }))
    .filter((tile) => typeof tile.state === "string");
}

/**
 * Renders one line summarising every status tile: which are red or amber when
 * there are any ("Systems: red housebank; amber bilge"), "Systems: all green"
 * when the monitored systems are fine, and nothing at all on a boat without
 * status tiles configured. Tiles in the opportunity or neutral (context
 * inactive) states are neither problems nor green, so they are ignored.
 *
 * @param {unknown} tiles - Value at `statusTiles.tiles`.
 * @returns {string} Empty when there is nothing to report.
 */
function systemsStatus(tiles) {
  const problems = { red: [], amber: [] };
  let green = 0;
  tileStatuses(tiles).forEach(({ id, state }) => {
    if (state === "red" || state === "amber") {
      problems[state].push(id);
      return;
    }
    if (state === "green") {
      green += 1;
    }
  });
  const groups = ["red", "amber"]
    .filter((state) => problems[state].length)
    .map((state) => `${state} ${problems[state].join(", ")}`);
  if (groups.length) {
    return `Systems: ${groups.join("; ")}`;
  }
  if (green) {
    return "Systems: all green";
  }
  return "";
}

/** Micron foreground escape for the red groups (3-digit RGB nibble form). */
const MICRON_RED = "`F900";
/** Micron foreground escape for the amber groups. */
const MICRON_AMBER = "`Faa0";
/** Micron foreground escape for the all-green summary. */
const MICRON_GREEN = "`F0a0";
/** Micron escape ending a colored span. */
const MICRON_RESET = "`f";

/**
 * Adds micron foreground-color escapes to a systems summary line so the
 * NomadNet page shows problems in red or amber and a healthy boat in green.
 * Any other line passes through untouched.
 *
 * The colored form is only for the micron page: the LXMF `Status` command
 * reply keeps the plain text {@link systemsStatus} produces.
 *
 * @param {string} line - A line from {@link telemetryLines}.
 * @returns {string} The line, colorized when it is the systems summary.
 */
function colorizeSystems(line) {
  if (line === "Systems: all green") {
    return `Systems: ${MICRON_GREEN}all green${MICRON_RESET}`;
  }
  if (!line.startsWith("Systems: ")) {
    return line;
  }
  const groups = line
    .slice("Systems: ".length)
    .split("; ")
    .map((group) => {
      const state = group.split(" ")[0];
      const color =
        state === "red" ? MICRON_RED : state === "amber" ? MICRON_AMBER : null;
      return color ? `${color}${group}${MICRON_RESET}` : group;
    });
  return `Systems: ${groups.join("; ")}`;
}

/**
 * Renders the vessel-status body lines — state, position, anchor, depth,
 * tide, wind, house battery, status tiles — one plain line per available
 * reading, absent readings omitted so neither the NomadNet page nor a Status
 * command reply ever shows empty placeholders.
 *
 * This is the single source of truth for "the vessel data we publish": the
 * micron page renders these lines under its "Vessel status" header, and the
 * LXMF Status command (commands/status.js) replies with exactly the same
 * lines, so the two views cannot drift apart.
 *
 * @param {object} [telemetry] - Raw Signal K self-path values, as built by
 *   {@link telemetryContext}. The `position` key takes the
 *   `navigation.position` object (`{latitude, longitude}`, optionally
 *   `{value}` wrapped); the `tiles` key takes the `statusTiles.tiles` subtree.
 * @returns {string[]} The non-empty formatted lines.
 */
function telemetryLines(telemetry = {}) {
  const tel = telemetry || {};
  return [
    formatVesselState(tel.state),
    formatPosition(tel.position),
    formatAnchorDistance(tel.anchorDistance),
    formatDepth(tel.depth),
    formatTide(tel.tideHeight, tel.tideState),
    formatWind(tel.windSpeed, tel.windDirection),
    formatBattery(
      tel.batterySoc,
      tel.batteryCurrent,
      readString(tel.energyOutlook),
    ),
    systemsStatus(tel.tiles),
  ].filter((line) => line && line.trim() !== "");
}

/**
 * Reads the boat's current telemetry from Signal K — the exact keys the
 * NomadNet index page renders — into the raw-value object
 * {@link telemetryLines} formats. Each entry is the untouched `getSelfPath`
 * result (plain value or `{value}` update wrapper; for the `tiles` key the
 * `statusTiles.tiles` subtree `getSelfPath` returns for an intermediate
 * path); the formatters unwrap and coerce from there, and drop anything
 * missing or non-numeric.
 *
 * Tolerates servers (and test fakes) that do not expose `getSelfPath` by
 * returning all-`undefined` readings, which render as no lines at all.
 *
 * @param {{getSelfPath?: (path: string) => unknown}|null|undefined} app
 * @returns {object} Raw telemetry keyed for {@link telemetryLines}.
 */
function telemetryContext(app) {
  const read = (path) => {
    if (!app || typeof app.getSelfPath !== "function") {
      return undefined;
    }
    try {
      return app.getSelfPath(path);
    } catch {
      return undefined;
    }
  };
  return {
    state: read("navigation.state"),
    position: read("navigation.position"),
    anchorDistance: read("navigation.anchor.distanceFromBow"),
    depth: read("environment.depth.belowSurface"),
    tideHeight: read("environment.tide.heightNow"),
    tideState: read("environment.tide.state"),
    windSpeed: read("environment.wind.speedOverGround"),
    windDirection: read("environment.wind.directionTrue"),
    batterySoc: read("electrical.batteries.house.capacity.stateOfCharge"),
    batteryCurrent: read("electrical.batteries.house.current"),
    energyOutlook: read(ENERGY_OUTLOOK_PATH),
    tiles: read(TILE_STATUS_BASE),
  };
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
 * @param {{path: string, label: string}[]} [context.crewPages] - Crew-only
 *   page links, rendered as a "Crew" section of micron links. Only supplied
 *   for identified crew: anonymous or non-crew viewers get no section at all
 *   and never learn the pages exist.
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

  const body = telemetryLines(cfg.telemetry);

  if (body.length) {
    lines.push("");
    lines.push(TELEMETRY_SECTION);
    lines.push(...body.map(colorizeSystems));
  }

  const footer = readString(cfg.footer);
  if (footer) {
    lines.push("");
    lines.push(footer);
  }

  const crewPages = (Array.isArray(cfg.crewPages) ? cfg.crewPages : [])
    .map((page) => ({
      path: readString(page && page.path),
      label: readString(page && page.label) || "Untitled",
    }))
    .filter((page) => page.path);
  if (crewPages.length) {
    lines.push("");
    lines.push(">Crew");
    for (const page of crewPages) {
      lines.push(`[${page.label}](${page.path})`);
    }
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
 * @param {(remoteIdentity?: unknown) => {vesselName?: unknown, banner?: unknown, telemetry?: object, crewPages?: {path: string, label: string}[]}}
 *   [options.getContext] - Called on each page request with the requester's
 *   identity (null for an anonymous, non-identified link) to build the render
 *   context (vessel name, optional banner, raw telemetry values, crew links),
 *   so the page stays live and per-viewer.
 * @param {(remoteIdentity?: unknown) => Promise<string>|string} [options.getCrewPage]
 *   Optional micron provider for the `/page/briefing.mu` crew page; when
 *   given, the page is registered beside the index. The provider is
 *   responsible for checking that the requester is crew.
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

  /** Page paths this site registered, so stop() removes them all. */
  const registeredPaths = [];

  /**
   * Wraps a page body provider in the §11 response generator with the
   * shared request logging: HTTP-style method/status synthesized from the
   * protocol's own conventions, elapsed time and requester identity.
   *
   * @param {(path: string, data: unknown, remoteIdentity: unknown) => Promise<string>|string} getPage
   *   Called with the request path, form data (null for a plain fetch) and
   *   the requester's identity (null for an anonymous, non-identified link).
   * @returns {(path: string, data: unknown, requestId: unknown, remoteIdentity: unknown, requestTime: unknown) => Promise<Uint8Array>}
   */
  const makeResponseGenerator =
    (getPage) =>
    async (path, data, _requestId, remoteIdentity, _requestTime) => {
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
        body = encodeUtf8(String(await getPage(path, data, remoteIdentity)));
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
    };

  await dest.registerRequestHandler(INDEX_PATH, {
    responseGenerator: makeResponseGenerator((_path, _data, remoteIdentity) =>
      // The requester's identity decides which links the page shows: crew
      // pages are linked only to identified crew
      renderPage(getContext(remoteIdentity)),
    ),
    allow: deps.Allow.ALL,
  });
  registeredPaths.push(INDEX_PATH);

  // Crew pages: the index links them only to identified crew (see
  // renderPage's crewPages context key), and the provider re-checks the
  // requester itself so a peer who knows the path by heart gets a crew-only
  // notice instead of the page. Anonymous requests see that notice too — a
  // deliberate trade: Allow.LIST would silently time out every client that
  // does not LINKIDENTIFY, crew included.
  if (typeof cfg.getCrewPage === "function") {
    await dest.registerRequestHandler(BRIEFING_PATH, {
      responseGenerator: makeResponseGenerator((_path, _data, remoteIdentity) =>
        cfg.getCrewPage(remoteIdentity),
      ),
      allow: deps.Allow.ALL,
    });
    registeredPaths.push(BRIEFING_PATH);
  }

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
    crewPagePath: typeof cfg.getCrewPage === "function" ? BRIEFING_PATH : null,
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
      for (const extraPath of registeredPaths.slice(1)) {
        try {
          await dest.removeRequestHandler(extraPath);
        } catch {
          /* best effort */
        }
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
  BRIEFING_PATH,
  UNKNOWN_VESSEL,
  MS_TO_KNOTS,
  RAD_TO_DEG,
  TELEMETRY_SECTION,
  setupNomadNet,
  renderPage,
  telemetryLines,
  telemetryContext,
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
  tileStatuses,
  systemsStatus,
  colorizeSystems,
};
