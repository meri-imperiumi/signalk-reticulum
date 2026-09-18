/**
 * Digital switching command.
 *
 * Lets a crew member toggle a Signal K digital switch by sending an LXMF
 * message of the form "turn <name> on" / "turn <name> off". The
 * `electrical.switches.<name>.state` path is written through the Signal K
 * `app.putSelfPath` API, and the node replies over LXMF to confirm.
 *
 * Crew-only: `handleMessage` already enforces that crew-only commands only run
 * for messages from a configured crew member. This command is additionally
 * gated by the `messaging.digital_switching` setting, so the operator must
 * explicitly opt in before any switch can be toggled over the mesh.
 *
 * Mirrors (and improves on) the `signalk-meshtastic` digital switching
 * command: a failed `putSelfPath` is reported back to the crew instead of
 * silently dropping the request.
 *
 * @file commands/switching.js
 */

const { toHex } = require("@reticulum/core");

/** Matches "turn <name> on|off", case-insensitive. Switch names may contain
 * dots to address nested switches, like Cerbo GX relays
 * ("turn gx.gxInternalRelay1 on"), matching the signalk-meshtastic parser. */
const SWITCH_RE = /turn ([a-z0-9]+(?:\.[a-z0-9]+)*) (on|off)/i;

/**
 * @param {{content?:string}|null|undefined} message
 * @returns {RegExpMatchArray|null}
 */
function matchSwitch(message) {
  if (message && typeof message.content === "string") {
    return message.content.match(SWITCH_RE);
  }
  return null;
}

/**
 * Wraps the Signal K `app.putSelfPath` callback API in a promise that resolves
 * once the put has completed, and rejects on a non-200 completion.
 *
 * @param {{putSelfPath?:Function}|null|undefined} app
 * @param {string} light - The switch name.
 * @param {boolean} value - The target state.
 * @returns {Promise<void>}
 */
function putSwitch(app, light, value) {
  return new Promise((resolve, reject) => {
    if (!app || typeof app.putSelfPath !== "function") {
      reject(new Error("Signal K put API unavailable"));
      return;
    }
    app.putSelfPath(`electrical.switches.${light}.state`, value, (res) => {
      // The put API calls back multiple times (e.g. PENDING then COMPLETED);
      // only act once the request has completed.
      if (res.state !== "COMPLETED") {
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(res.message || `HTTP ${res.statusCode}`));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  crewOnly: true,
  example: "Turn <switch name> on",
  accept: (message, settings) => {
    // Operator must have opted in via the messaging settings.
    if (
      !(settings && settings.messaging && settings.messaging.digital_switching)
    ) {
      return false;
    }
    return matchSwitch(message) !== null;
  },
  handle: async (message, _settings, deliver, app, linkId) => {
    const match = matchSwitch(message);
    const light = match[1];
    const word = match[2].toLowerCase();
    const value = word === "on";
    const dest = toHex(message.sourceHash);
    try {
      await putSwitch(app, light, value);
    } catch (e) {
      // Report the failure back to the crew so they are not left waiting, then
      // re-throw so the operator also sees it in the Signal K log.
      await deliver(
        dest,
        "",
        `Could not switch ${light}: ${e.message}`,
        linkId,
      );
      throw e;
    }
    await deliver(dest, "", `OK, ${light} is ${word}`, linkId);
  },
};
