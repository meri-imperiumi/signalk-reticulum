/**
 * Resolves the node's LXMF "appearance" (icon + colors) and builds the
 * `FIELD_ICON_APPEARANCE` message field that carries it to peers.
 *
 * Some Reticulum messaging clients (Sideband, MeshChat) render a per-peer
 * avatar from this field, so crew members see a recognisable icon for the boat
 * instead of a generic one. The field travels inside an LXMF **message** — it
 * is not part of the `lxmf.delivery` announce `app_data`, which only carries
 * `[display_name, stamp_cost, supported_functions]` (LXMF/LXMRouter.py
 * `get_announce_app_data`). Sideband reads it from `lxm.fields[0x04]`
 * (`SidebandCore` core.py:3310) and sends it alongside telemetry
 * (core.py:4785), so this plugin attaches it to the telemetry broadcast for
 * the same effect.
 *
 * The wire value is a 3-element msgpack array:
 *
 *   [ icon(str), foreground(bin 3 bytes), background(bin 3 bytes) ]
 *
 * Sideband packs the colors with `struct.pack("!BBB", r, g, b)` (3 raw bytes)
 * and reads them back by indexing `cbytes[0..2]`, so the colors MUST be
 * emitted as msgpack `bin` (a `Uint8Array`), not an array of ints — otherwise
 * the receiver's `struct.unpack("!B", bytes([cbytes[0]]))` raises and the
 * appearance is dropped.
 *
 * @file appearance.js
 */

// LXMF moved out of the package root in @reticulum/core 0.6 — deep-import it.
const { LXMFConstants } = require("@reticulum/core/src/lxmf/index.js");

/** Spec field id for the sender icon/colors (LXMF/LXMF.py:11). */
const FIELD_ICON_APPEARANCE = LXMFConstants.FIELD_ICON_APPEARANCE;

/** Material Design Icon name for sailing vessels (AIS ship type 36). */
const SAIL_ICON = "sail-boat";
/** Material Design Icon name for motor / other vessels. */
const MOTOR_ICON = "ferry";
/** AIS ship-type id for "Sailing" (the only sailing-vessel code). */
const AIS_SAILING = 36;

/** Default foreground color when none is configured (white). */
const DEFAULT_FG = [255, 255, 255];
/** Default background color when none is configured (nautical indigo). */
const DEFAULT_BG = [26, 35, 126];

/**
 * Coerces a value into an integer, unwrapping Signal K `{value: ...}` updates
 * and the `design.aisShipType` `{id, name}` object along the way.
 *
 * Returns `null` when no integer can be derived, so callers can treat "unknown"
 * distinctly from a real (if unusual) ship-type code.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function readInt(value) {
  let v = value;
  for (let i = 0; i < 4 && v && typeof v === "object"; i++) {
    if ("id" in v) {
      v = v.id;
      break;
    }
    if ("value" in v) {
      v = v.value;
      continue;
    }
    break;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const n = Number.parseInt(v.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Resolves the Material Design Icon name for this node.
 *
 * An explicitly configured icon always wins. Otherwise the AIS ship type is
 * consulted: a sailing vessel (type 36) gets the sail-boat icon, and any other
 * known type gets the ferry (motor) icon. When no AIS ship type is available
 * the sail-boat icon is used as the default — this is a sailing-focused
 * integration, and the sail-boat icon is the better guess for an unconfigured
 * recreational vessel. Operators of motor vessels can either set the AIS ship
 * type or configure the icon explicitly.
 *
 * @param {object} [options]
 * @param {unknown} [options.configured] - Configured icon name (plugin config).
 * @param {unknown} [options.aisShipType] - Value at
 *   `vessels.self.design.aisShipType` (`{id, name}`, possibly `{value}` wrapped).
 * @returns {string}
 */
function resolveIcon({ configured, aisShipType } = {}) {
  const override = readString(configured);
  if (override) {
    return override;
  }
  const id = readInt(aisShipType);
  if (id === AIS_SAILING) {
    return SAIL_ICON;
  }
  if (id == null) {
    return SAIL_ICON;
  }
  return MOTOR_ICON;
}

/**
 * Parses a CSS-style hex color (`#rrggbb`, `#rgb`, or `rrggbb`) into an
 * `[r, g, b]` triple of 0-255 integers. Returns `null` when the string is not
 * a valid hex color.
 *
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
function parseHexColor(value) {
  if (typeof value !== "string") {
    return null;
  }
  let s = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    return null;
  }
  return [
    Number.parseInt(s.slice(0, 2), 16),
    Number.parseInt(s.slice(2, 4), 16),
    Number.parseInt(s.slice(4, 6), 16),
  ];
}

/**
 * Coerces a color config value into an `[r, g, b]` triple of 0-255 integers,
 * accepting either a hex string (`#rrggbb` / `#rgb`) or an `[r, g, b]` array.
 * Returns `null` when the value cannot be interpreted as a color.
 *
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
function toRgb(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const clamp = (v) => Math.max(0, Math.min(255, Math.trunc(Number(v) || 0)));
    return [clamp(value[0]), clamp(value[1]), clamp(value[2])];
  }
  return parseHexColor(value);
}

/**
 * Resolves the foreground and background colors, falling back to the defaults
 * when either is absent or unparseable.
 *
 * @param {object} [options]
 * @param {unknown} [options.fg] - Foreground color (hex string or `[r,g,b]`).
 * @param {unknown} [options.bg] - Background color (hex string or `[r,g,b]`).
 * @returns {{fg: [number, number, number], bg: [number, number, number]}}
 */
function resolveColors({ fg, bg } = {}) {
  return {
    fg: toRgb(fg) || DEFAULT_FG,
    bg: toRgb(bg) || DEFAULT_BG,
  };
}

/**
 * Resolves the full appearance (icon + colors) from plugin configuration and
 * the vessel's AIS ship type.
 *
 * @param {object} [options]
 * @param {unknown} [options.icon] - Configured Material Design Icon name.
 * @param {unknown} [options.fgColor] - Configured foreground color.
 * @param {unknown} [options.bgColor] - Configured background color.
 * @param {unknown} [options.aisShipType] - Value at
 *   `vessels.self.design.aisShipType`.
 * @returns {{icon: string, fg: [number, number, number], bg: [number, number, number]}}
 */
function resolveAppearance({ icon, fgColor, bgColor, aisShipType } = {}) {
  return {
    icon: resolveIcon({ configured: icon, aisShipType }),
    ...resolveColors({ fg: fgColor, bg: bgColor }),
  };
}

/**
 * Builds the LXMF message `fields` entry carrying the node's appearance.
 *
 * The colors are emitted as `Uint8Array` so the msgpack encoder writes them as
 * `bin` (0xc4), matching Sideband's `struct.pack("!BBB", r, g, b)` wire shape
 * and what its reader (`struct.unpack` over `cbytes[0..2]`) expects. Returning
 * them as an array of ints would instead serialise as a fixarray, which the
 * receiver cannot index as bytes and silently drops.
 *
 * @param {{icon: string, fg: [number, number, number], bg: [number, number, number]}} appearance
 * @param {number} [fieldId] - Field id to use (defaults to
 *   `FIELD_ICON_APPEARANCE`); injected so tests can vary it.
 * @returns {Map<number, [string, Uint8Array, Uint8Array]>}
 */
function buildAppearanceFields(appearance, fieldId = FIELD_ICON_APPEARANCE) {
  const fgBin = new Uint8Array(appearance.fg);
  const bgBin = new Uint8Array(appearance.bg);
  return new Map([[fieldId, [appearance.icon, fgBin, bgBin]]]);
}

/**
 * Returns an LXMF message `fields` Map combining `base` with the appearance
 * field. When `appearance` is absent or has no icon, `base` is returned
 * unchanged so callers without an appearance are not penalised. A fresh `Map`
 * is returned when merging so the caller's `base` is never mutated.
 *
 * Only a `Map` (or `null`/`undefined`) is accepted as the base: LXMF field ids
 * MUST be integers on the wire, and a plain object would coerce numeric keys
 * to strings, which msgpack would then serialise as `str` keys instead of the
 * required integer keys. Callers that need integer keys (the only kind LXMF
 * defines) must pass a `Map`.
 *
 * @param {Map<any, any> | null | undefined} base
 * @param {{icon?: string, fg?: [number, number, number], bg?: [number, number, number]} | null | undefined} appearance
 * @param {number} [fieldId] - Field id for the appearance entry.
 * @returns {Map<any, any>}
 */
function withAppearance(base, appearance, fieldId = FIELD_ICON_APPEARANCE) {
  if (!appearance || !appearance.icon) {
    return base instanceof Map ? base : new Map();
  }
  const merged = new Map();
  if (base instanceof Map) {
    for (const [k, v] of base) {
      merged.set(k, v);
    }
  }
  const appearanceFields = buildAppearanceFields(appearance, fieldId);
  for (const [k, v] of appearanceFields) {
    merged.set(k, v);
  }
  return merged;
}

/**
 * Coerces a Signal K self-path or config value into a trimmed string,
 * tolerating a wrapped `{value: ...}` update value.
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

module.exports = {
  FIELD_ICON_APPEARANCE,
  SAIL_ICON,
  MOTOR_ICON,
  AIS_SAILING,
  DEFAULT_FG,
  DEFAULT_BG,
  readInt,
  readString,
  resolveIcon,
  parseHexColor,
  toRgb,
  resolveColors,
  resolveAppearance,
  buildAppearanceFields,
  withAppearance,
};
