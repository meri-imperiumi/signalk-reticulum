/**
 * Renders the `signalk-passage-briefing` plugin's cached payload as text the
 * mesh can carry: the LXMF `Briefing` command reply (commands/briefing.js) and
 * the NomadNet `/page/briefing.mu` page both come from {@link briefingLines},
 * so the two views cannot drift apart — the same pattern telemetry follows
 * between the Status command and the NomadNet index page.
 *
 * The briefing plugin compiles its Unified Weather Payload and caches it under
 * its plugin data dir (`weather/here.json` for conditions at the vessel, plus
 * `weather/latest-<route>.json` per route briefing). Only summary meta rides
 * the Signal K bus (`navigation.briefing.*`); the payload itself is served to
 * its webapp over HTTP. Reading the cache file directly is the mesh-side
 * equivalent: the plugin data dir is derived the way the server lays it out
 * (`<configPath>/plugin-config-data/<plugin id>`) — the same sibling lookup
 * the briefing plugin itself uses to reach other plugins' files.
 *
 * Rendering is deliberately mesh-shaped: compact summary lines over the next
 * 24 hours (wind, gusts, waves, pressure, cloud), the track-filtered bulletin
 * warnings, GDACS hazards, the energy outlook events, tonight's sun and moon,
 * and the sky events the briefing compiled. Nothing here recomputes the
 * briefing's physics — comfort comes from the compiled tier, hazards from the
 * filtered event list — so the mesh view is always the briefing plugin's own
 * view of the world.
 *
 * @file briefing.js
 */

const { access, readdir, readFile } = require("node:fs/promises");
const path = require("node:path");

const { markdownize, markdownJoin } = require("./markdown");

/** The sibling plugin whose cached briefing payload we render. */
const BRIEFING_PLUGIN_ID = "signalk-passage-briefing";

// Summary meta the briefing plugin publishes on the bus. Values may be
// absent on a boat without the plugin; every consumer treats them as
// best-effort context, never as the payload itself.
const META_GENERATED_AT = "navigation.briefing.generatedAt";
const META_ROUTE = "navigation.briefing.route";
const META_COMFORT = "navigation.briefing.comfort";
const META_STALE = "navigation.briefing.stale";
/** The vessel's timezone offset from UTC, published by signalk-ships-time
 * (`(-)hhmm` encoding, e.g. `200` = UTC+2, `-930` = UTC-9:30). Times in the
 * briefing render in the ship's time when it is available (the Signal K
 * visuals convention: ship's time with no timezone specifier), falling back
 * to explicit-`Z` UTC when the path carries no value. */
const META_TIME_OFFSET = "environment.time.timezoneOffset";

/**
 * The briefing plugin's own freshness thresholds (its HERE_TTL_MS and
 * ROUTE_TTL_MS): a here payload is stale after 3 h, a route briefing after
 * 26 h. Used when the bus meta carries no `stale` flag.
 */
const HERE_TTL_MS = 3 * 60 * 60 * 1000;
const ROUTE_TTL_MS = 26 * 60 * 60 * 1000;

/** Hours the conditions summary looks ahead from now. */
const OUTLOOK_HOURS = 24;
/** How far back a step may sit before now and still count as current. */
const PAST_GRACE_MS = 60 * 60 * 1000;
/** Upper bound on the sky-event and hazard lines rendered. */
const MAX_HAZARD_LINES = 6;
const MAX_SKY_LINES = 6;
/** Upper bound on the CAP-alert and front-passage lines rendered. */
const MAX_ALERT_LINES = 6;
const MAX_FRONT_LINES = 6;

/**
 * Resolves the briefing plugin's data dir from the server config layout:
 * `<configPath>/plugin-config-data/<plugin id>`. `app.config.configPath` is
 * the config directory (`~/.signalk` by default); when it is missing the
 * plugin's own data dir is walked up from instead
 * (`<configPath>/plugin-config-data/<this plugin>`).
 *
 * @param {{config?: {configPath?: string}, getDataDirPath?: () => string}|null|undefined} app
 * @returns {string|null} Absolute dir, or null when it cannot be derived.
 */
function briefingDataDir(app) {
  const configRoot =
    (app && app.config && app.config.configPath) ||
    (typeof (app && app.getDataDirPath) === "function"
      ? path.dirname(path.dirname(app.getDataDirPath()))
      : null);
  if (!configRoot) {
    return null;
  }
  return path.join(configRoot, "plugin-config-data", BRIEFING_PLUGIN_ID);
}

/**
 * Whether the briefing plugin's data dir (and thus potentially a cached
 * payload) exists at all — used to decide whether the NomadNet site should
 * serve and link a briefing page. The cache may still be empty (the plugin
 * compiles its first briefing only after its first online window); the page
 * itself then says so.
 *
 * @param {{config?: {configPath?: string}, getDataDirPath?: () => string}|null|undefined} app
 * @returns {Promise<boolean>}
 */
async function briefingAvailable(app) {
  const dir = briefingDataDir(app);
  if (!dir) {
    return false;
  }
  try {
    await access(path.join(dir, "weather"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads one Signal K self-path as a plain value, tolerating `{value}` update
 * wrappers and servers without `getSelfPath`.
 *
 * @param {{getSelfPath?: (path: string) => unknown}|null|undefined} app
 * @param {string} selfPath
 * @returns {unknown} The unwrapped value, or undefined when unavailable.
 */
function selfValue(app, selfPath) {
  if (!app || typeof app.getSelfPath !== "function") {
    return undefined;
  }
  try {
    const node = app.getSelfPath(selfPath);
    if (node === null || node === undefined) {
      return undefined;
    }
    if (typeof node === "object" && "value" in node) {
      return node.value;
    }
    return node;
  } catch {
    return undefined;
  }
}

/**
 * Reads the briefing plugin's summary meta off the bus — route label, comfort
 * tier and stale flag — as plain values, for renderers that want the meta
 * context alongside the payload.
 *
 * @param {{getSelfPath?: (path: string) => unknown}|null|undefined} app
 * @returns {{route: unknown, comfort: unknown, stale: unknown}}
 */
function briefMeta(app) {
  return {
    route: selfValue(app, META_ROUTE),
    comfort: selfValue(app, META_COMFORT),
    stale: selfValue(app, META_STALE),
    timeOffset: selfValue(app, META_TIME_OFFSET),
  };
}

/**
 * Parses a Signal K `environment.time.timezoneOffset` value (`(-)hhmm`
 * encoding, e.g. `200` = UTC+2, `-930` = UTC-9:30) into minutes. Accepts
 * numbers and numeric strings; null when absent or malformed (minutes ≥ 60,
 * |hhmm| ≥ 2400, non-finite) — the same rules the briefing webapp applies.
 *
 * @param {number|string|null|undefined} value
 * @returns {number|null} Offset in minutes, or null when unusable.
 */
function parseTimezoneOffset(value) {
  const raw = typeof value === "string" ? Number(value) : value;
  if (raw == null || !Number.isFinite(raw)) {
    return null;
  }
  const abs = Math.abs(Math.round(raw));
  const minutes = Math.trunc(abs / 100) * 60 + (abs % 100);
  if (abs % 100 >= 60 || abs >= 2400) {
    return null;
  }
  return Math.sign(raw) * minutes;
}

/**
 * Loads the freshest cached briefing payload. The bus meta's `generatedAt`
 * names the compile the crew is being pointed at (route briefings and here
 * payloads coexist in the cache), so a matching file wins; otherwise the
 * newest fetched payload does.
 *
 * @param {{config?: {configPath?: string}, getDataDirPath?: () => string, getSelfPath?: (path: string) => unknown}|null|undefined} app
 * @returns {Promise<{payload: object, fetchedAt: string}|null>} Null when the
 *   briefing plugin is not installed or has nothing cached.
 */
async function loadBriefing(app) {
  const dir = briefingDataDir(app);
  if (!dir) {
    return null;
  }
  const weatherDir = path.join(dir, "weather");
  let entries;
  try {
    entries = await readdir(weatherDir);
  } catch {
    return null;
  }
  const generatedAt = selfValue(app, META_GENERATED_AT);
  const candidates = [
    "here.json",
    ...entries
      .filter((name) => name.startsWith("latest-") && name.endsWith(".json"))
      .sort(),
  ];
  let best = null;
  for (const name of candidates) {
    let payload;
    try {
      payload = JSON.parse(await readFile(path.join(weatherDir, name), "utf8"));
    } catch {
      continue;
    }
    const fetchedAt = payload?.metadata?.fetchedAt;
    if (typeof fetchedAt !== "string" || !fetchedAt) {
      continue;
    }
    if (generatedAt && fetchedAt === generatedAt) {
      return { payload, fetchedAt };
    }
    if (!best || fetchedAt > best.fetchedAt) {
      best = { payload, fetchedAt };
    }
  }
  return best;
}

/**
 * Parses a forecast timestamp. Open-Meteo hourly keys arrive in GMT without
 * an offset suffix ("2026-10-12T08:00"), so bare timestamps read as UTC —
 * the same rule the briefing plugin's own `parseUtcTimestamp` applies.
 *
 * @param {string} iso
 * @returns {number} Epoch milliseconds, or NaN when unparseable.
 */
function parseUtc(iso) {
  if (typeof iso !== "string") {
    return Number.NaN;
  }
  const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  return new Date(hasOffset ? iso : `${iso}Z`).getTime();
}

/**
 * Formats an ISO instant as `MM-DD HH:MMZ` (UTC, explicitly suffixed) — the
 * fallback stamp when the vessel publishes no ship's time.
 *
 * @param {string} iso
 * @returns {string} Empty when the instant is unparseable.
 */
function fmtUtc(iso) {
  return fmtStamp(iso, null);
}

/**
 * Formats an ISO instant for the mesh report. With the vessel's timezone
 * offset it renders the stamp in the ship's local time as `MM-DD HH:MM` —
 * no timezone specifier, the Signal K visuals convention for ship's time —
 * and without an offset it falls back to explicit-`Z` UTC
 * (`MM-DD HH:MMZ`). Both carry the same `MM-DD HH:MM` shape the briefing
 * webapp stamps with; the webapp appends the offset label instead of the
 * bare local time, the mesh text stays with the visuals rule.
 *
 * @param {string} iso
 * @param {number|null} [offsetMinutes] - Ship's timezone offset from UTC
 *   in minutes (from {@link parseTimezoneOffset}), null for UTC.
 * @returns {string} Empty when the instant is unparseable.
 */
function fmtStamp(iso, offsetMinutes = null) {
  const ms = parseUtc(iso);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const shifted =
    Number.isFinite(offsetMinutes) && offsetMinutes !== null
      ? new Date(ms + offsetMinutes * 60000)
      : new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const body = `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  return Number.isFinite(offsetMinutes) && offsetMinutes !== null
    ? body
    : `${body}Z`;
}

/**
 * Human age of a compile: "45m old" under two hours, then "3h old", then
 * "2d 3h old" past two days.
 *
 * @param {string} fetchedAt
 * @param {Date} [now]
 * @returns {string} Empty when the instant is unparseable.
 */
function fmtAge(fetchedAt, now = new Date()) {
  const ms = parseUtc(fetchedAt);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const minutes = Math.max(0, Math.round((now.getTime() - ms) / 60000));
  if (minutes < 120) {
    return `${minutes}m old`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h old`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h old` : `${days}d old`;
}

const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/**
 * Renders a bearing in degrees as a 16-point compass sector.
 *
 * @param {number} deg
 * @returns {string}
 */
function compass(deg) {
  if (!Number.isFinite(deg)) {
    return "";
  }
  const normalized = ((deg % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16];
}

/**
 * Rounds for display: null passes through, otherwise a finite number with at
 * most one decimal.
 *
 * @param {number} value
 * @returns {number|null}
 */
function rounded(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/**
 * Whether the payload is past the briefing plugin's own freshness window —
 * 3 h for a here payload, 26 h for a route briefing. The bus meta's `stale`
 * flag wins when present; the mode comes from the meta's `route` label (route
 * payloads carry no mode of their own).
 *
 * @param {object} payload
 * @param {object} [meta] - Bus meta values (`route`, `stale`).
 * @param {Date} [now]
 * @returns {boolean}
 */
function isStale(payload, meta = {}, now = new Date()) {
  if (typeof meta.stale === "boolean") {
    return meta.stale;
  }
  const fetched = parseUtc(payload?.metadata?.fetchedAt);
  if (!Number.isFinite(fetched)) {
    return true;
  }
  const route = typeof meta.route === "string" && meta.route;
  const ttl = route ? ROUTE_TTL_MS : HERE_TTL_MS;
  return now.getTime() - fetched > ttl;
}

/**
 * Summarizes the next 24 hours of conditions across the payload's waypoints —
 * one waypoint for a here briefing, the sampled track for a route. Steps too
 * far in the past (a payload compiled hours ago) are skipped, and a payload
 * whose forecast range has slid away entirely falls back to its first steps
 * so the line still says something true about the briefing's own window.
 *
 * @param {object} payload
 * @param {Date} [now]
 * @returns {string[]} Wind, wave, pressure and cloud lines; only the lines
 *   with data.
 */
function conditionsLines(payload, now = new Date()) {
  const waypoints = Array.isArray(payload?.waypoints) ? payload.waypoints : [];
  const all = [];
  for (const waypoint of waypoints) {
    const forecasts = Array.isArray(waypoint?.forecasts)
      ? waypoint.forecasts
      : [];
    for (const step of forecasts) {
      const ms = parseUtc(step?.timestamp);
      if (Number.isFinite(ms)) {
        all.push({ ms, step });
      }
    }
  }
  if (!all.length) {
    return [];
  }
  all.sort((a, b) => a.ms - b.ms);
  const start = now.getTime() - PAST_GRACE_MS;
  const end = now.getTime() + OUTLOOK_HOURS * 3600000;
  let window = all.filter(({ ms }) => ms >= start && ms <= end);
  if (!window.length) {
    window = all.slice(0, OUTLOOK_HOURS);
  }

  const winds = [];
  const gusts = [];
  const waves = [];
  const clouds = [];
  let windSector = "";
  let maxWind = null;
  let maxWave = null;
  let wavePeriod = null;
  for (const { step } of window) {
    const surface = step?.surface ?? {};
    const marine = step?.marine ?? {};
    const tws = surface.tws;
    if (Number.isFinite(tws)) {
      winds.push(tws);
      if (maxWind === null || tws > maxWind) {
        maxWind = tws;
        windSector = compass(surface.twd);
      }
    }
    if (Number.isFinite(surface.gust)) {
      gusts.push(surface.gust);
    }
    if (Number.isFinite(marine.hsCombined)) {
      waves.push(marine.hsCombined);
      if (maxWave === null || marine.hsCombined > maxWave) {
        maxWave = marine.hsCombined;
        wavePeriod = marine.tpCombined;
      }
    }
    if (Number.isFinite(surface.cloudCover)) {
      clouds.push(surface.cloudCover);
    }
  }

  const lines = [];
  if (winds.length) {
    const lo = Math.round(Math.min(...winds));
    const hi = Math.round(Math.max(...winds));
    let text = hi > lo ? `Wind: ${lo}-${hi} kn` : `Wind: ${hi} kn`;
    if (windSector) {
      text += ` from ${windSector}`;
    }
    if (gusts.length) {
      text += `, gusts to ${Math.round(Math.max(...gusts))} kn`;
    }
    lines.push(text);
  }
  if (waves.length) {
    const height = rounded(maxWave);
    const parts = [`Waves: max ${height} m`];
    if (Number.isFinite(wavePeriod)) {
      parts.push(`at ${Math.round(wavePeriod)} s`);
    }
    lines.push(parts.join(" "));
  }
  const pressures = window
    .map(({ step }) => step?.surface?.mslp)
    .filter((p) => Number.isFinite(p));
  if (pressures.length) {
    const latest = Math.round(pressures[pressures.length - 1]);
    const delta = pressures[pressures.length - 1] - pressures[0];
    const trend = delta <= -2 ? "falling" : delta >= 2 ? "rising" : "steady";
    lines.push(`Pressure: ${latest} hPa, ${trend}`);
  }
  if (clouds.length) {
    lines.push(`Cloud cover: up to ${Math.round(Math.max(...clouds))} %`);
  }
  return lines;
}

/**
 * The track-filtered NAVTEX/metarea bulletin: one block per retained,
 * on-track paragraph, exactly as the briefing plugin filtered them.
 *
 * @param {object} payload
 * @returns {string[]} The label line plus the block texts.
 */
function bulletinLines(payload) {
  const bulletin = payload?.metareaBulletin;
  const blocks = (Array.isArray(bulletin?.blocks) ? bulletin.blocks : [])
    .map((block) => block?.text)
    .filter((text) => typeof text === "string" && text.trim() !== "");
  if (!blocks.length) {
    return [];
  }
  return ["Warnings:", ...blocks];
}

/**
 * The GDACS hazards the briefing kept near the vessel or track.
 *
 * @param {object} payload
 * @returns {string[]} The label line plus one line per event.
 */
function hazardLines(payload) {
  const events = Array.isArray(payload?.hazardEvents)
    ? payload.hazardEvents
    : [];
  if (!events.length) {
    return [];
  }
  const lines = events.slice(0, MAX_HAZARD_LINES).map((event) => {
    const parts = [];
    if (typeof event.alertLevel === "string" && event.alertLevel) {
      parts.push(event.alertLevel);
    }
    if (typeof event.type === "string" && event.type) {
      parts.push(`${event.type}:`);
    }
    if (typeof event.title === "string" && event.title) {
      parts.push(event.title);
    }
    if (Number.isFinite(event.distanceNm)) {
      const bearing = compass(event.bearingDeg);
      parts.push(
        `(${Math.round(event.distanceNm)} nm${bearing ? ` ${bearing}` : ""})`,
      );
    }
    return parts.join(" ");
  });
  return ["⚠ Hazards:", ...lines];
}

/**
 * The energy predictor's outlook events as the briefing compiled them.
 *
 * @param {object} payload
 * @returns {string[]} The label line plus one line per event.
 */
function energyLines(payload, offsetMinutes = null) {
  const events = Array.isArray(payload?.energyEvents)
    ? payload.energyEvents
    : [];
  const lines = events.map((event) => {
    if (event?.type === "surplus") {
      const netWh = Number.isFinite(event.netWh) ? event.netWh : null;
      const until = event.endTimestamp
        ? fmtStamp(event.endTimestamp, offsetMinutes)
        : "";
      const parts = ["Surplus"];
      if (netWh !== null) {
        parts.push(`${rounded(netWh / 1000)} kWh`);
      }
      if (until) {
        parts.push(`until ${until}`);
      }
      return parts.join(" ");
    }
    if (event?.type === "deficit") {
      const parts = ["Deficit"];
      if (typeof event.status === "string" && event.status) {
        parts.push(`(${event.status})`);
      }
      if (Number.isFinite(event.timeToEmpty)) {
        parts.push(`${rounded(event.timeToEmpty / 3600)}h to empty`);
      }
      return parts.join(" ");
    }
    return null;
  });
  const kept = lines.filter((line) => line);
  return kept.length ? ["🔋 Energy:", ...kept] : [];
}

/**
 * Tonight's sun and moon from the compiled ephemeris: the first night of the
 * window with its crossings and the moon's illumination at dusk.
 *
 * @param {object} payload
 * @returns {string[]} The label line plus one or two lines.
 */
function tonightLines(payload, offsetMinutes = null) {
  const night = Array.isArray(payload?.celestialNights)
    ? payload.celestialNights[0]
    : null;
  if (!night) {
    return [];
  }
  const lines = [];
  const sun = [];
  const sunset = fmtStamp(night.sunset, offsetMinutes);
  const sunrise = fmtStamp(night.sunrise, offsetMinutes);
  // The ↓/↑ arrows are the briefing webapp's own sky-segment marks: setting
  // and rising crossings after the time stamp
  if (sunset) {
    sun.push(`${sunset}↓`);
  }
  if (sunrise) {
    sun.push(`${sunrise}↑`);
  }
  if (sun.length) {
    lines.push(`☀ Sun: ${sun.join(", ")}`);
  }
  const moon = [];
  const moonrise = fmtStamp(night.moonrise, offsetMinutes);
  const moonset = fmtStamp(night.moonset, offsetMinutes);
  if (moonrise) {
    moon.push(`${moonrise}↑`);
  }
  if (moonset) {
    moon.push(`${moonset}↓`);
  }
  if (Number.isFinite(night.moonIllumination)) {
    moon.push(`${Math.round(night.moonIllumination * 100)}% lit`);
  }
  if (moon.length) {
    lines.push(`☽ Moon: ${moon.join(", ")}`);
  }
  return lines.length ? ["☾ Tonight:", ...lines] : [];
}

/**
 * The compiled sky events — conjunctions, oppositions, meteor-shower peaks,
 * eclipses, reentries and visible launches — with their human descriptions.
 *
 * @param {object} payload
 * @param {Date} [now]
 * @returns {string[]} The label line plus up to {@link MAX_SKY_LINES} events.
 */
function skyLines(payload, now = new Date(), offsetMinutes = null) {
  const events = Array.isArray(payload?.spaceEvents) ? payload.spaceEvents : [];
  const upcoming = events
    .map((event) => ({
      ms: parseUtc(event?.timestamp),
      description:
        typeof event?.description === "string" ? event.description.trim() : "",
    }))
    .filter(({ ms, description }) => Number.isFinite(ms) && description)
    .sort((a, b) => a.ms - b.ms);
  const horizon = now.getTime() + OUTLOOK_HOURS * 3600000;
  const lines = upcoming
    .filter(({ ms }) => ms <= horizon)
    .slice(0, MAX_SKY_LINES)
    .map(({ ms, description }) => {
      const stamp = fmtStamp(new Date(ms).toISOString(), offsetMinutes);
      return stamp ? `${stamp} ${description}` : description;
    });
  return lines.length ? ["✦ Sky:", ...lines] : [];
}

/**
 * The effective departure the served schedule anchors to (work doc #15):
 * the auto daylight anchor or the crew's override, with the anchor's own
 * reason wording — "Underway — from now", "First light …". Absent on a
 * here payload, which has no schedule to anchor.
 *
 * @param {object} payload
 * @param {number|null} [offsetMinutes] - Ship's timezone offset in minutes.
 * @returns {string[]} The line, or nothing.
 */
function departureLines(payload, offsetMinutes = null) {
  const departure = payload?.departure;
  if (!departure || typeof departure.time !== "string") {
    return [];
  }
  const stamp = fmtStamp(departure.time, offsetMinutes);
  let text;
  if (departure.reason === "underway") {
    text = "Underway — from now";
  } else if (departure.reason === "next_dawn" && stamp) {
    text = `First light ${stamp}`;
  } else if (departure.reason === "daylight_prep" && stamp) {
    text = `${stamp}, after prep`;
  } else if (departure.reason === "no_dawn" && stamp) {
    text = `${stamp}, no dawn in forecast`;
  } else {
    text = stamp || null;
  }
  return text ? [`⚓ Departure: ${text}`] : [];
}

/**
 * The official CAP alerts the briefing kept near the vessel or route —
 * the alerting-feed counterpart of the METAREA bulletin blocks, rendered
 * the way the briefing webapp's alert card reads them: severity, event
 * or headline, expiry, and the instruction on its own line.
 *
 * @param {object} payload
 * @param {number|null} [offsetMinutes] - Ship's timezone offset in minutes.
 * @returns {string[]} The label line plus up to {@link MAX_ALERT_LINES}
 *   alerts (instruction lines ride along uncounted).
 */
function capLines(payload, offsetMinutes = null) {
  const alerts = Array.isArray(payload?.capAlerts) ? payload.capAlerts : [];
  if (!alerts.length) {
    return [];
  }
  const lines = [];
  for (const alert of alerts.slice(0, MAX_ALERT_LINES)) {
    const severity =
      typeof alert.severity === "string" && alert.severity
        ? alert.severity.toUpperCase()
        : null;
    const event = (typeof alert.event === "string" && alert.event.trim()) || "";
    const headline =
      (typeof alert.headline === "string" && alert.headline.trim()) || "";
    const body =
      event && headline && event !== headline
        ? `${event} — ${headline}`
        : headline || event || "Official alert";
    const parts = [severity ? `${severity} ${body}` : body];
    const expires = alert.expires ? fmtStamp(alert.expires, offsetMinutes) : "";
    if (expires) {
      parts.push(`expires ${expires}`);
    }
    lines.push(parts.join(" — "));
    if (typeof alert.instruction === "string" && alert.instruction.trim()) {
      lines.push(alert.instruction.trim());
    }
  }
  return lines.length ? ["🚨 Alerts:", ...lines] : [];
}

/**
 * The tracked synoptic fronts crossing the boat's scheduled position
 * (work doc #50), one line per passage with the expected wind shift, plus
 * the automatic-analysis caveat — the briefing carries it on every render,
 * and the mesh text is one.
 *
 * @param {object} payload
 * @param {number|null} [offsetMinutes] - Ship's timezone offset in minutes.
 * @returns {string[]} The label line, one line per passage and the caveat.
 */
function frontLines(payload, offsetMinutes = null) {
  const passages = Array.isArray(payload?.fronts?.passages)
    ? payload.fronts.passages
    : [];
  if (!passages.length) {
    return [];
  }
  const KIND_LABELS = {
    cold: "Cold front",
    warm: "Warm front",
    stationary: "Stationary front",
    front: "Front",
    trough: "Trough",
  };
  const lines = passages.slice(0, MAX_FRONT_LINES).map((passage) => {
    const label = KIND_LABELS[passage?.kind] ?? "Front";
    const stamp = fmtStamp(passage?.time, offsetMinutes);
    let text = stamp ? `${label} crossing ${stamp}` : `${label} crossing`;
    if (Number.isFinite(passage?.shiftDeg)) {
      text += `, wind shift ~${Math.round(passage.shiftDeg)}°`;
    }
    return text;
  });
  return [
    "🌬 Fronts:",
    ...lines,
    "Automatic analysis — official charts are authoritative",
  ];
}

/**
 * The territorial-waters transitions along the route (work doc #17):
 * enter/leave crossings with the distance along the plan they happen at
 * (the payload's own convention — from the boat on a trimmed briefing),
 * and the ocean-connectivity marker on a leave — beyond it the metered-
 * ocean rules apply. The payload carries distances, not times; the webapp
 * derives the hours from its own simulation, which the mesh text does not
 * run.
 *
 * @param {object} payload
 * @returns {string[]} The label line plus one line per transition.
 */
function zoneLines(payload) {
  const transitions = Array.isArray(payload?.zoneTransitions)
    ? payload.zoneTransitions
    : [];
  if (!transitions.length) {
    return [];
  }
  const lines = transitions.map((transition) => {
    const name =
      (typeof transition?.territory?.name === "string" &&
        transition.territory.name) ||
      "territorial waters";
    const verb = transition?.kind === "leave" ? "Leaves" : "Enters";
    let text = `${verb} ${name} waters`;
    if (Number.isFinite(transition?.distanceFromStartNm)) {
      text += ` at ${Math.round(transition.distanceFromStartNm)} nm`;
    }
    if (transition?.connectivity === "ocean") {
      text += " — ocean beyond";
    }
    return text;
  });
  return lines.length ? ["⚑ Waters:", ...lines] : [];
}

/**
 * Renders the cached briefing payload as the shared body lines — compile
 * stamp, mode, comfort, the 24 h conditions summary, warnings, hazards,
 * energy, tonight's sky. Sections without data are left out entirely so the
 * mesh text never shows empty placeholders.
 *
 * @param {object} [params]
 * @param {object} [params.payload] - The briefing plugin's payload.
 * @param {object} [params.meta] - Bus meta values: `route`, `comfort`,
 *   `stale` (see {@link loadBriefing} for how the payload is chosen).
 * @param {Date} [params.now]
 * @returns {string[]} The non-empty lines.
 */
function briefingLines({ payload, meta = {}, now = new Date() } = {}) {
  if (!payload?.waypoints?.length) {
    return [];
  }
  const timeOffset = parseTimezoneOffset(meta.timeOffset);
  const lines = [];
  const stamp = fmtStamp(payload.metadata?.fetchedAt, timeOffset);
  if (stamp) {
    let line = `Compiled ${stamp}`;
    const age = fmtAge(payload.metadata?.fetchedAt, now);
    if (age) {
      line += `, ${age}`;
    }
    if (isStale(payload, meta, now)) {
      line += " (stale)";
    }
    lines.push(line);
  }
  const route =
    typeof meta.route === "string" && meta.route ? meta.route : null;
  lines.push(route ? `Route: ${route}` : "Conditions here, next 24h");
  lines.push(...departureLines(payload, timeOffset));
  const comfort =
    (typeof payload.comfortTier === "string" && payload.comfortTier) ||
    (typeof meta.comfort === "string" && meta.comfort) ||
    null;
  if (comfort) {
    lines.push(`Comfort: ${comfort}`);
  }
  lines.push(...conditionsLines(payload, now));
  lines.push(...bulletinLines(payload));
  lines.push(...capLines(payload, timeOffset));
  lines.push(...hazardLines(payload));
  lines.push(...frontLines(payload, timeOffset));
  lines.push(...energyLines(payload, timeOffset));
  lines.push(...zoneLines(payload));
  lines.push(...tonightLines(payload, timeOffset));
  lines.push(...skyLines(payload, now, timeOffset));
  return lines;
}

// Exact section-label lines the plain renderer emits; the micron page turns
// each into a NomadNet section header. The glyphs are the timeline marks the
// briefing webapp uses for the same kinds (⚠ hazards, 🔋 energy, ☾ moon,
// ✦ space).
const SECTION_LABELS = [
  "Warnings:",
  "🚨 Alerts:",
  "⚠ Hazards:",
  "🌬 Fronts:",
  "🔋 Energy:",
  "⚑ Waters:",
  "☾ Tonight:",
  "✦ Sky:",
];

// Micron foreground escapes (3-digit RGB nibbles) and the span terminator,
// the same syntax the mesh's own pages use.
const MICRON_RED = "`F900";
const MICRON_AMBER = "`Faa0";
const MICRON_GREEN = "`F0a0";
const MICRON_RESET = "`f";

const HAZARD_LEVEL_COLORS = {
  red: MICRON_RED,
  orange: MICRON_AMBER,
  amber: MICRON_AMBER,
  green: MICRON_GREEN,
  // CAP severities (the webapp renders them uppercase)
  extreme: MICRON_RED,
  severe: MICRON_AMBER,
};

/**
 * Micronizes one briefing line for the NomadNet page: section labels become
 * section headers, a hazard line's leading alert level gets its color, and a
 * stale compile stamp gets the amber treatment.
 *
 * @param {string} line
 * @returns {string}
 */
function micronizeLine(line) {
  if (SECTION_LABELS.includes(line)) {
    return `>${line.slice(0, -1)}`;
  }
  const level = line.split(" ")[0];
  const color = HAZARD_LEVEL_COLORS[level.toLowerCase()];
  if (color) {
    return `${color}${level}${MICRON_RESET}${line.slice(level.length)}`;
  }
  if (line.endsWith(" (stale)")) {
    return `${line.slice(0, -" (stale)".length)} ${MICRON_AMBER}(stale)${MICRON_RESET}`;
  }
  return line;
}

/**
 * Renders the briefing as a NomadNet micron page: a heading, the shared body
 * lines with colors and section headers, or a quiet placeholder when nothing
 * is cached.
 *
 * @param {object} [params]
 * @param {object} [params.payload] - The briefing plugin's payload.
 * @param {object} [params.meta] - Bus meta values.
 * @param {Date} [params.now]
 * @returns {string} Micron markup.
 */
function briefingPage(params = {}) {
  const lines = briefingLines(params);
  if (!lines.length) {
    return ">Passage briefing\n\nNo briefing available\n";
  }
  return `>Passage briefing\n\n${lines.map(micronizeLine).join("\n")}\n`;
}

/**
 * Renders the briefing as the Markdown LXMF `Briefing` command reply — the
 * LXMF `FIELD_RENDERER` field tells clients such as Sideband to render it as
 * Markdown (see {@link module:plugin/markdown}): a bold heading, bold labels
 * and bold section headings over the same body lines, or the placeholder when
 * nothing is cached. A client that ignores the renderer field reads the raw
 * asterisks, which still read fine as plain text.
 *
 * @param {object} [params] - See {@link briefingLines}.
 * @returns {string} Markdown text.
 */
function briefingMarkdown(params = {}) {
  const lines = briefingLines(params);
  if (!lines.length) {
    return "**Passage briefing**\n\nNo briefing available";
  }
  return `**Passage briefing**\n\n${markdownJoin(lines.map(markdownize))}`;
}

module.exports = {
  BRIEFING_PLUGIN_ID,
  META_GENERATED_AT,
  META_ROUTE,
  META_COMFORT,
  META_STALE,
  META_TIME_OFFSET,
  briefingDataDir,
  briefingAvailable,
  briefMeta,
  loadBriefing,
  briefingLines,
  briefingMarkdown,
  briefingPage,
  fmtUtc,
  fmtStamp,
  parseTimezoneOffset,
  fmtAge,
  compass,
  parseUtc,
  isStale,
  conditionsLines,
  bulletinLines,
  capLines,
  hazardLines,
  frontLines,
  energyLines,
  zoneLines,
  departureLines,
  tonightLines,
  skyLines,
  micronizeLine,
};
