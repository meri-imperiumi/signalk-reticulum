/**
 * The command registry: which commands exist, who may use them, and what
 * examples to show them. Kept separate from the dispatcher (index.js) so
 * commands like Help can list the registry without a require cycle — the
 * dispatcher, Help and the fallback all read from here.
 *
 * @file commands/registry.js
 */

const { toHex } = require("@reticulum/core");
const { effectiveCrew } = require("../notifications");

/** Registered commands, keyed by name. Add new commands here. */
const commands = {
  ping: require("./ping"),
  status: require("./status"),
  briefing: require("./briefing"),
  briefingSubscribe: require("./briefing-subscribe"),
  briefingUnsubscribe: require("./briefing-unsubscribe"),
  switching: require("./switching"),
  log: require("./log"),
  help: require("./help"),
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
 * The command examples the sender of a message is allowed to use: crew see
 * everything, anyone else only the public commands.
 *
 * @param {{crew?:unknown}|null|undefined} settings
 * @param {boolean} fromCrew
 * @returns {string[]} The `example` of each available command.
 */
function availableExamples(settings, fromCrew) {
  return Object.keys(commands)
    .filter((name) => fromCrew || !commands[name].crewOnly)
    .map((name) => commands[name].example);
}

// Assigned rather than replaced: help.js requires this module while it is
// still loading (help is one of the commands), and the cycle's partial
// reference must end up being the same object this assignment fills
Object.assign(module.exports, {
  commands,
  isFromCrew,
  availableExamples,
});
