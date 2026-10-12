/**
 * Crew "Subscribe briefing" command: opts the sender into the daily briefing
 * push (module:plugin/brief-subscriptions) — they then receive the boat's
 * passage briefing once a day, delivered when the `signalk-passage-briefing`
 * plugin compiles a fresh payload, without having to remember to ask.
 *
 * Crew-only, like the Briefing command itself: subscriptions are keyed by the
 * sender's `lxmf.delivery` destination hash and dispatch intersects them with
 * the currently configured crew, so only real crew can ever receive a push.
 *
 * @file commands/briefing-subscribe.js
 */

const { toHex } = require("@reticulum/core");
const {
  loadSubscriptions,
  saveSubscriptions,
  subscriptionsPath,
} = require("../brief-subscriptions");

/** Matches "Subscribe brief[ing]" (and the "sub" shorthand), whitespace-tolerant. */
const SUBSCRIBE_RE = /^\s*sub(?:scribe)?\s+(?:brief|briefing)\s*$/i;

module.exports = {
  crewOnly: true,
  example: "Subscribe briefing",
  accept: (message) =>
    typeof message === "object" &&
    message !== null &&
    typeof message.content === "string" &&
    SUBSCRIBE_RE.test(message.content),
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
    if (existing && typeof existing === "object") {
      return deliver(
        destinationHashHex,
        "",
        "Already subscribed — the daily briefing reaches you once a day.",
        linkId,
      );
    }
    try {
      subscriptions[destinationHashHex] = {
        subscribedAt: new Date().toISOString(),
      };
      await saveSubscriptions(file, subscriptions);
    } catch (e) {
      return deliver(
        destinationHashHex,
        "",
        `Subscription failed: ${e.message}`,
        linkId,
      );
    }
    return deliver(
      destinationHashHex,
      "",
      "Subscribed. You will get the passage briefing once a day, delivered whenever the boat compiles a fresh one.",
      linkId,
    );
  },
};
