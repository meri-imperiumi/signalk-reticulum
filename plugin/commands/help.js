/**
 * Public "Help" command: lists the commands the sender may use — crew see
 * everything, anyone else only the public ones. So somebody who found the
 * node on the mesh knows what the node is and what it answers to, without
 * waiting for a human that isn't there.
 *
 * Mirrors the `signalk-meshtastic` help command.
 *
 * @file commands/help.js
 */

const { toHex } = require("@reticulum/core");
// The registry requires this module (help is a command), so its exports are
// only read inside the handler, after the cycle has settled
const registry = require("./registry");

/** Matches "Help", case-insensitive, with optional surrounding whitespace. */
const HELP_RE = /^\s*help\s*$/i;

/**
 * Renders the help reply: a one-line identity statement plus the caller's
 * available commands as a Markdown bullet list.
 *
 * @param {string[]} examples - The available command examples.
 * @returns {string}
 */
function helpText(examples) {
  return [
    "Automated boat node — nobody reads this live. Commands:",
    ...examples.map((example) => `- ${example}`),
  ].join("\n");
}

module.exports = {
  crewOnly: false,
  example: "Help",
  accept: (message) =>
    typeof message === "object" &&
    message !== null &&
    typeof message.content === "string" &&
    HELP_RE.test(message.content),
  handle: (message, settings, deliver, _app, linkId) =>
    deliver(
      toHex(message.sourceHash),
      "",
      // The list depends on who asks: crew see the crew-only commands too,
      // computed at reply time so config changes apply without a restart
      helpText(
        registry.availableExamples(
          settings,
          registry.isFromCrew(message, settings),
        ),
      ),
      linkId,
      { markdown: true },
    ),
};
