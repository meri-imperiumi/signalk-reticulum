/**
 * Crew "Briefing" command: replies with the boat's passage briefing — the
 * weather outlook, bulletin warnings, hazards, energy outlook and sky events
 * the `signalk-passage-briefing` plugin compiled — rendered from its cached
 * payload by {@link module:plugin/briefing}. The reply carries the LXMF
 * `FIELD_RENDERER` Markdown field, so Sideband renders the bold headings and
 * labels; the same lines also serve the NomadNet `/page/briefing.mu` page in
 * micron form.
 *
 * Crew-only: the briefing is compiled for the boat's own passage, and the
 * read plus render cost radio time that strangers on the mesh should not be
 * able to spend. Like the Status command the reply goes out as one message —
 * LXMF carries long payloads.
 *
 * @file commands/briefing.js
 */

const { toHex } = require("@reticulum/core");
const { loadBriefing, briefMeta, briefingMarkdown } = require("../briefing");

/** Matches "Briefing" or "Brief", with optional surrounding whitespace. */
const BRIEFING_RE = /^\s*(?:briefing|brief)\s*$/i;

module.exports = {
  crewOnly: true,
  example: "Briefing",
  accept: (message) =>
    typeof message === "object" &&
    message !== null &&
    typeof message.content === "string" &&
    BRIEFING_RE.test(message.content),
  // Replies to the sender's `lxmf.delivery` destination, carried by the source
  // hash; the arrival `linkId` is forwarded so the reply rides back over the
  // same established Link the request came on — same policy as the other
  // commands.
  handle: async (message, _settings, deliver, app, linkId) => {
    const briefing = await loadBriefing(app);
    return deliver(
      toHex(message.sourceHash),
      "",
      briefingMarkdown({
        payload: briefing?.payload,
        meta: briefMeta(app),
        now: new Date(),
      }),
      linkId,
      { markdown: true },
    );
  },
};
