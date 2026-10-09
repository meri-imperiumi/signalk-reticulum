/**
 * Crew "Log <text>" command: appends a manual entry to the boat logbook
 * through the Signal K `logentries` resource API (provided by the
 * signalk-logbook plugin), so the crew can keep the logbook updated from any
 * LXMF messaging device on the mesh.
 *
 * A hashtag in the text picks the entry category and is removed from the
 * entry text, like "Log Changed the engine oil #maintenance". The entry is
 * credited to the sending crew member's configured name — the command is
 * crew-only, so the sender is always a configured crew member; a crew entry
 * without a real label (the resolver falls back to the hash) leaves the
 * entry unauthored.
 *
 * Mirrors the `signalk-meshtastic` log command.
 *
 * @file commands/log.js
 */

const { randomUUID } = require("node:crypto");
const { toHex } = require("@reticulum/core");
const { effectiveCrew } = require("../notifications");

// Hashtags pick the entry category, like "log Changed the engine oil
// #maintenance". A hashtag must be delimited by whitespace or string edges
const HASHTAG_REGEX = /(?:^|\s)#([a-z0-9_-]+)(?=\s|$)/gi;

/** Matches "log <text>", case-insensitive: "log" (with optional surrounding
 * whitespace, like the other commands' triggers) followed by whitespace and
 * at least one word of entry text. Words merely starting with "log" (like
 * "logo design ideas") are not entries. */
const LOG_RE = /^\s*log\s+\S/i;

/** The crew resolver falls back to the identity or destination hash as the
 * member label when no name is configured; a hash is not a crew name. */
const HASH_LIKE_RE = /^[0-9a-f]{32}$/i;

/**
 * Splits the raw entry text into the logbook entry shape: the text with
 * hashtags stripped and whitespace collapsed, plus the first hashtag
 * (lowercased) as the entry category.
 *
 * @param {string} text - The entry text with the "log " trigger removed.
 * @returns {{text: string, origin: string, category?: string}}
 */
function parseEntry(text) {
  const categories = [];
  const stripped = text.replace(HASHTAG_REGEX, (_match, name) => {
    categories.push(name.toLowerCase());
    return " ";
  });
  const entry = {
    text: stripped.replace(/\s+/g, " ").trim(),
    origin: "manual",
  };
  if (categories.length) {
    [entry.category] = categories;
  }
  return entry;
}

/**
 * Resolves the author for a logbook entry: the configured name of the crew
 * member whose lxmf.delivery destination hash matches the message source.
 *
 * @param {{sourceHash?:Uint8Array}|null|undefined} message
 * @param {{crew?:unknown}|null|undefined} settings
 * @returns {string|undefined} The crew member's name, or `undefined` when the
 *   sender has no real configured name (the entry is then left unauthored).
 */
function authorFor(message, settings) {
  if (!message?.sourceHash) {
    return undefined;
  }
  const sourceHex = toHex(message.sourceHash);
  const member = effectiveCrew(settings?.crew).find(
    (entry) => entry.destinationHash === sourceHex,
  );
  if (!member || typeof member.name !== "string") {
    return undefined;
  }
  const name = member.name.trim();
  if (!name || HASH_LIKE_RE.test(name)) {
    return undefined;
  }
  return name;
}

module.exports = {
  crewOnly: true,
  example: "Log <text>",
  accept: (message) =>
    typeof message?.content === "string" && LOG_RE.test(message.content),
  // Replies to the sender's `lxmf.delivery` destination, carried by the source
  // hash; the arrival `linkId` is forwarded so the reply rides back over the
  // same established Link the entry came on (undefined for opportunistic
  // inbound messages) — same policy as the other commands.
  handle: (message, settings, deliver, app, linkId) => {
    const body = message.content.replace(/^\s*log\s+/i, "");
    const entry = parseEntry(body);
    const author = authorFor(message, settings);
    if (author) {
      entry.author = author;
    }
    const dest = toHex(message.sourceHash);
    if (!entry.text) {
      return deliver(dest, "", "Nothing to log", linkId);
    }
    if (
      !app?.resourcesApi ||
      typeof app.resourcesApi.setResource !== "function"
    ) {
      return deliver(dest, "", "Logbook not available", linkId);
    }
    return app.resourcesApi
      .setResource("logentries", randomUUID(), entry)
      .then(() => deliver(dest, "", "OK, logged", linkId))
      .catch((e) => deliver(dest, "", `Logging failed: ${e.message}`, linkId));
  },
};
