/**
 * Crew "Unsubscribe briefing" command: cancels the sender's daily briefing
 * push (module:plugin/brief-subscriptions). Idempotent — unsubscribing when
 * not subscribed simply says so, and never touches the store.
 *
 * @file commands/briefing-unsubscribe.js
 */

const { toHex } = require("@reticulum/core");
const {
  loadSubscriptions,
  saveSubscriptions,
  subscriptionsPath,
} = require("../brief-subscriptions");

/** Matches "Unsubscribe brief[ing]" (and the "unsub" shorthand), whitespace-tolerant. */
const UNSUBSCRIBE_RE = /^\s*unsub(?:scribe)?\s+(?:brief|briefing)\s*$/i;

module.exports = {
  crewOnly: true,
  example: "Unsubscribe briefing",
  accept: (message) =>
    typeof message === "object" &&
    message !== null &&
    typeof message.content === "string" &&
    UNSUBSCRIBE_RE.test(message.content),
  handle: async (message, _settings, deliver, app, linkId) => {
    const destinationHashHex = toHex(message.sourceHash);
    const file = subscriptionsPath(app);
    if (!file) {
      return deliver(
        destinationHashHex,
        "",
        "Daily briefings unavailable: this node has no plugin storage.",
        linkId,
      );
    }
    const { subscriptions } = await loadSubscriptions(app);
    const existing = subscriptions[destinationHashHex];
    if (!existing || typeof existing !== "object") {
      return deliver(
        destinationHashHex,
        "",
        "Not subscribed to the daily briefing.",
        linkId,
      );
    }
    try {
      delete subscriptions[destinationHashHex];
      await saveSubscriptions(file, subscriptions);
    } catch (e) {
      return deliver(
        destinationHashHex,
        "",
        `Unsubscription failed: ${e.message}`,
        linkId,
      );
    }
    return deliver(
      destinationHashHex,
      "",
      "Unsubscribed — no more daily briefings.",
      linkId,
    );
  },
};
