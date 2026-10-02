/**
 * Incoming LXMF command handling.
 *
 * Mirrors the `signalk-meshtastic` command pattern: every command is an object
 * with
 *   - `crewOnly`  (boolean) — only run for messages from configured crew,
 *   - `example`   (string)  — a human-readable example of the trigger,
 *   - `accept(message, settings)`  — whether this command handles the message,
 *   - `handle(message, settings, deliver, app)` — performs the action.
 *
 * {@link handleMessage} dispatches an incoming LXMF message to the first
 * command whose `accept` returns true (first match wins), replying through the
 * caller-supplied `deliver` callback bound to the LXMF router.
 *
 * @file commands/index.js
 */

const { toHex } = require("@reticulum/core");
const { effectiveCrew } = require("../notifications");

/** Registered commands, keyed by name. Add new commands here. */
const commands = {
  ping: require("./ping"),
  status: require("./status"),
  switching: require("./switching"),
};

/**
 * Whether an incoming LXMF message originates from one of the configured crew
 * members, by comparing the message source hash against the crew destinations.
 *
 * @param {{sourceHash?:Uint8Array}|null|undefined} message
 * @param {{crew?:unknown}|null|undefined} settings
 * @returns {boolean}
 */
function isFromCrew(message, settings) {
  if (!message || !message.sourceHash) {
    return false;
  }
  const crew = effectiveCrew(settings && settings.crew);
  if (crew.length === 0) {
    return false;
  }
  const sourceHex = toHex(message.sourceHash);
  return crew.some((member) => member.destinationHash === sourceHex);
}

/**
 * Dispatches an incoming LXMF message to the first matching command.
 *
 * Crew-only commands are skipped unless {@link isFromCrew} says the message
 * comes from a configured crew member. The first command whose `accept`
 * returns true has its `handle` awaited and no further commands are tried, so
 * each message produces at most one response. Per-command failures are logged
 * and do not abort the caller.
 *
 * `linkId` (the inbound message's arrival Link id, `event.detail.link` from
 * the LXMRouter "message" event) is forwarded to the matched command so its
 * reply rides back over the same established Link instead of falling back to
 * flaky opportunistic delivery. It may be omitted for callers that have no
 * arrival link (e.g. a synthetic dispatch); the command then replies
 * opportunistically.
 *
 * @param {{sourceHash:Uint8Array, content?:string}|null|undefined} message
 * @param {object|null|undefined} settings
 * @param {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null)=>Promise<void>|undefined} deliver
 * @param {{debug?:(...args:any[])=>void, error?:(...args:any[])=>void}|null|undefined} [app]
 * @param {Uint8Array|null|undefined} [linkId] - The arrival Link id to reply
 *   over, from the router's `event.detail.link`.
 * @returns {Promise<void>}
 */
async function handleMessage(message, settings, deliver, app, linkId) {
  if (!message || !deliver) {
    return;
  }
  const fromCrew = isFromCrew(message, settings);
  for (const name of Object.keys(commands)) {
    const command = commands[name];
    if (!command || typeof command.accept !== "function") {
      continue;
    }
    if (command.crewOnly && !fromCrew) {
      continue;
    }
    if (!command.accept(message, settings)) {
      continue;
    }
    try {
      await command.handle(message, settings, deliver, app, linkId);
      if (app && typeof app.debug === "function") {
        app.debug(`LXMF message handled by command "${name}"`);
      }
    } catch (e) {
      if (app && typeof app.error === "function") {
        app.error(`LXMF command "${name}" failed: ${e.message}`);
      }
    }
    // First match wins: stop after handling one command.
    return;
  }
}

module.exports = {
  commands,
  isFromCrew,
  handleMessage,
};
