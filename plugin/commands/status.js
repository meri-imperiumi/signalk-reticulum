/**
 * Replies to a "Status" LXMF message with the boat's current readings — the
 * same lines the NomadNet index page renders under "Vessel status" (state,
 * position, anchor, depth, tide, wind, house battery), produced by the same
 * {@link module:plugin/nomadnet} formatters so the page and the reply can
 * never drift apart.
 *
 * The vessel name is not included: the sender already sees it as the
 * destination's announced display name. LXMF carries long payloads (and a
 * reply rides the arrival Link or falls back to store-and-forward), so the
 * whole report goes out as a single message — no radio-packet splitting.
 *
 * Available to everyone (not crew-only), mirroring the `signalk-meshtastic`
 * status command.
 *
 * @file commands/status.js
 */

const { toHex } = require("@reticulum/core");
const { telemetryContext, telemetryLines } = require("../nomadnet");

/** Reply shown when the server reports none of the known readings. */
const EMPTY_REPLY = "No telemetry available";

module.exports = {
  crewOnly: false,
  example: "Status",
  accept: (message) =>
    typeof message === "object" &&
    message !== null &&
    typeof message.content === "string" &&
    message.content.trim().toLowerCase() === "status",
  // Replies to the sender's `lxmf.delivery` destination, carried by the source
  // hash; the arrival `linkId` is forwarded so the reply rides back over the
  // same established Link the request came on (undefined for opportunistic
  // inbound messages) — same policy as the ping command.
  handle: (message, _settings, deliver, app, linkId) => {
    const lines = telemetryLines(telemetryContext(app));
    return deliver(
      toHex(message.sourceHash),
      "",
      lines.length ? lines.join("\n") : EMPTY_REPLY,
      linkId,
    );
  },
};
