/**
 * Decides when a Signal K notification should be forwarded to the crew as an
 * LXMF message, and builds the message content.
 *
 * The notification *decision* logic (debouncing, alert-state gating, message
 * building) is free of any Reticulum/LXMF coupling and can be unit-tested in
 * isolation. The actual delivery is performed by a caller-supplied `deliver`
 * callback (see {@link sendNotification}). The one Reticulum-aware piece is
 * crew resolution ({@link effectiveCrew}), which derives each member's
 * `lxmf.delivery` destination hash from their configured Reticulum identity
 * hash.
 *
 * @file notifications.js
 */

const { deriveLxmfDestinationHash } = require("./identity");

/**
 * Signal K notification states that trigger an LXMF alert to the crew.
 * Matches the Meshtastic integration: the two most urgent states.
 */
const ALERT_STATES = ["alarm", "emergency"];

/**
 * How long after an alert has cleared before another alert on the same path is
 * forwarded again. Stops a flapping sensor (e.g. a bilge switch) from flooding
 * the crew with messages, while still re-alerting once the condition genuinely
 * returns after a quiet period.
 */
const DEBOUNCE_MS = 5 * 60 * 1000;

/** Matches a canonical 16-byte LXMF destination hash (32 lowercase hex chars). */
const DESTINATION_HASH_RE = /^[0-9a-f]{32}$/i;
/** Matches a canonical 16-byte Reticulum identity hash (32 lowercase hex chars). */
const IDENTITY_HASH_RE = /^[0-9a-f]{32}$/i;

/**
 * @typedef {Object} Episode
 * @property {Date} startTime - When this alert episode first fired.
 * @property {string} openState - The notification state that opened it.
 * @property {number} transitions - Times the alert re-occurred while open.
 * @property {Date|null} clearedSince - When the alert cleared, or null if open.
 */

/**
 * Normalises a hex string for comparison/validation: trims, lower-cases and
 * strips the whitespace and dashes parsers typically tolerate.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHex(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/[\s-]/g, "");
}

/**
 * Returns whether a tracked episode counts as cleared at `now`: either there is
 * no episode (assumed cleared), or enough time has elapsed since it cleared.
 *
 * @param {Episode|undefined} episode
 * @param {Date} now
 * @returns {boolean}
 */
function wasCleared(episode, now) {
  if (!episode) {
    return true;
  }
  if (!episode.clearedSince) {
    return false;
  }
  return now - episode.clearedSince >= DEBOUNCE_MS;
}

/**
 * Pure decision of whether a notification value should be forwarded to the
 * crew right now.
 *
 * Tracks per-path "episodes" in `episodes` (a Map) so that a flapping alert is
 * only forwarded once per active episode, and is only forwarded again once it
 * has stayed cleared for at least {@link DEBOUNCE_MS}.
 *
 * @param {string} path - The notification path (e.g. "notifications.electrical.bilge").
 * @param {{state?:string, message?:string, method?:string[]}|null|undefined} value
 * @param {Map<string, Episode>} episodes - Mutable episode tracker.
 * @param {{messaging?:{send_alerts?:boolean}}|null|undefined} settings
 * @param {Date} [now]
 * @returns {boolean}
 */
function shouldWeSendNotification(path, value, episodes, settings, now) {
  const currentTime = now || new Date();

  if (!settings || !settings.messaging || !settings.messaging.send_alerts) {
    return false;
  }
  if (!value) {
    return false;
  }

  const episode = episodes.get(path);

  if (!value.state || !ALERT_STATES.includes(value.state)) {
    // Not an alert state: mark any open episode as clearing.
    if (episode) {
      if (!episode.clearedSince) {
        episode.clearedSince = currentTime;
      }
      if (wasCleared(episode, currentTime)) {
        episodes.delete(path);
      }
    }
    return false;
  }

  // Alert state.
  if (!episode) {
    // First alert of this kind.
    episodes.set(path, {
      startTime: currentTime,
      openState: value.state,
      transitions: 1,
      clearedSince: null,
    });
    return true;
  }

  if (!wasCleared(episode, currentTime)) {
    // Already alerted for this episode and not cleared long enough.
    episode.transitions += 1;
    return false;
  }

  // Cleared long enough: reopen the episode and alert again.
  episode.clearedSince = null;
  return true;
}

/**
 * Builds the LXMF title and content for an alert notification.
 *
 * An audible bell (`\u0007`) is prepended when the notification requests a
 * `sound` method, so supported receiving devices raise an audible alert.
 *
 * @param {string} path
 * @param {{message?:string, method?:string[]}|null|undefined} value
 * @returns {{title:string, content:string}}
 */
function buildAlertMessage(path, value) {
  const subject = path.replace(/^notifications\./, "");
  const message =
    value && value.message ? value.message : `Alert on ${subject}`;
  const wantsSound =
    !!value &&
    Array.isArray(value.method) &&
    value.method.indexOf("sound") !== -1;
  return {
    title: `Signal K: ${subject}`,
    content: `${wantsSound ? "\u0007 " : ""}${message}`,
  };
}

/**
 * Normalises the configured crew list into `{name, destinationHash}` entries.
 *
 * Each crew member is configured by their **Reticulum identity hash** (a
 * protocol-agnostic 32-char hex value), from which the `lxmf.delivery`
 * destination hash — the address LXMF messages are delivered to — is derived.
 * Using the identity hash instead of the raw LXMF destination hash means the
 * same crew entry can later be reached over other protocols that share the
 * identity (e.g. identified NomadNet page requests) without reconfiguration.
 *
 * For backward compatibility an entry may instead carry a legacy `destination`
 * field (a raw `lxmf.delivery` destination hash); it is used verbatim. Entries
 * with neither a valid `identity` nor a valid legacy `destination` are skipped.
 *
 * @param {unknown} crew
 * @param {(...args:any[])=>void} [log] - Called for each skipped entry.
 * @returns {{name:string, destinationHash:string}[]}
 */
function effectiveCrew(crew, log) {
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

    // Preferred: a Reticulum identity hash. Derive the lxmf.delivery
    // destination hash from it so the entry is protocol-agnostic.
    const identityHash = normalizeHex(entry.identity);
    if (IDENTITY_HASH_RE.test(identityHash)) {
      result.push({
        name: name || identityHash,
        destinationHash: deriveLxmfDestinationHash(identityHash),
      });
      continue;
    }

    // Legacy fallback: a raw lxmf.delivery destination hash, used verbatim.
    const destinationHash = normalizeHex(entry.destination);
    if (DESTINATION_HASH_RE.test(destinationHash)) {
      result.push({ name: name || destinationHash, destinationHash });
      continue;
    }

    if (log) {
      log(
        `Skipping crew member "${
          name || "?"
        }" with invalid Reticulum identity / LXMF destination: ${
          entry.identity || entry.destination
        }`,
      );
    }
  }
  return result;
}

/**
 * Forwards an alert notification to every configured crew member over LXMF.
 *
 * Delegates the actual delivery to `deliver(destinationHash, title, content)`,
 * which the caller binds to the LXMF router (see `messaging.makeDeliverer`).
 * Per-recipient failures are logged and do not abort the remaining recipients.
 *
 * @param {string} path
 * @param {{state?:string, message?:string, method?:string[]}|null|undefined} value
 * @param {Map<string, Episode>} episodes
 * @param {{messaging?:{send_alerts?:boolean}, crew?:unknown}|null|undefined} settings
 * @param {(destinationHash:string, title:string, content:string)=>Promise<void>|undefined} deliver
 * @param {{error?:(...args:any[])=>void, debug?:(...args:any[])=>void}} [app]
 * @returns {Promise<boolean>} Whether the notification was forwarded to anyone.
 */
async function sendNotification(path, value, episodes, settings, deliver, app) {
  const error =
    app && typeof app.error === "function" ? (msg) => app.error(msg) : () => {};
  const debug =
    app && typeof app.debug === "function" ? (msg) => app.debug(msg) : () => {};

  if (!deliver) {
    // Messaging not available (e.g. LXMF router failed to start).
    return false;
  }

  if (!shouldWeSendNotification(path, value, episodes, settings)) {
    return false;
  }

  const crew = effectiveCrew(settings && settings.crew, debug);
  if (crew.length === 0) {
    // No crew destinations configured.
    return false;
  }

  const { title, content } = buildAlertMessage(path, value || {});
  let sent = 0;
  for (const member of crew) {
    try {
      await deliver(member.destinationHash, title, content);
      sent += 1;
    } catch (e) {
      error(`Failed to send alert to ${member.name}: ${e.message}`);
    }
  }
  return sent > 0;
}

module.exports = {
  ALERT_STATES,
  DEBOUNCE_MS,
  DESTINATION_HASH_RE,
  IDENTITY_HASH_RE,
  normalizeHex,
  wasCleared,
  shouldWeSendNotification,
  buildAlertMessage,
  effectiveCrew,
  sendNotification,
};
