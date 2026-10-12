/**
 * Incoming LXMF command handling.
 *
 * Mirrors the `signalk-meshtastic` command pattern: every command is an object
 * with
 *   - `crewOnly`  (boolean) — only run for messages from configured crew,
 *   - `example`   (string)  — a human-readable example of the trigger,
 *   - `accept(message, settings)`  — whether this command handles the message,
 *   - `handle(message, settings, deliver, app, linkId)` — performs the action.
 *
 * {@link handleMessage} dispatches an incoming LXMF message to the first
 * command whose `accept` returns true (first match wins), replying through the
 * caller-supplied `deliver` callback bound to the LXMF router. A message no
 * command accepts gets the rate-limited fallback reply (commands/fallback.js)
 * listing what the sender may use, so strangers and typo-ing crew are never
 * left waiting for a human that isn't there.
 *
 * @file commands/index.js
 */

const { commands, isFromCrew, availableExamples } = require("./registry");
const fallback = require("./fallback");

/**
 * Validates a candidate reply-to message id: the raw 32-byte LXMF `messageId`
 * (SHA-256 over the wire payload per §5.5) that `FIELD_REPLY_TO` (§5.9.9)
 * carries. Synthetic messages (tests, fakes) often have no id — those simply
 * get no threading.
 *
 * @param {unknown} messageId
 * @returns {Uint8Array|null}
 */
function replyToId(messageId) {
  return messageId instanceof Uint8Array && messageId.length === 32
    ? messageId
    : null;
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
 * Every reply made through the callback is threaded: when the inbound message
 * carries a 32-byte `messageId` it is attached to the reply's deliver opts as
 * `replyTo`, which the deliverer turns into the LXMF `FIELD_REPLY_TO` field
 * (§5.9.9) so clients such as Columba render the reply as "in reply to" the
 * original message. A message without a usable id replies unthreaded.
 *
 * @param {{sourceHash:Uint8Array, content?:string, messageId?:Uint8Array|null}|null|undefined} message
 * @param {object|null|undefined} settings
 * @param {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null, opts?:object)=>Promise<void>|undefined} deliver
 * @param {{debug?:(...args:any[])=>void, error?:(...args:any[])=>void}|null|undefined} [app]
 * @param {Uint8Array|null|undefined} [linkId] - The arrival Link id to reply
 *   over, from the router's `event.detail.link`.
 * @returns {Promise<void>}
 */
async function handleMessage(message, settings, deliver, app, linkId) {
  if (!message || !deliver) {
    return;
  }
  // Thread every reply made through this dispatch under the message being
  // answered: the deliverer turns the id into FIELD_REPLY_TO (§5.9.9). An
  // explicit `replyTo` in a command's own opts still wins.
  const replyTo = replyToId(message.messageId);
  const replyDeliver = replyTo
    ? (dest, title, content, linkId2, opts = {}) =>
        deliver(dest, title, content, linkId2, { replyTo, ...opts })
    : deliver;
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
      await command.handle(message, settings, replyDeliver, app, linkId);
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
  // Nothing accepted the message: the rate-limited fallback explains the node
  // and lists what this sender may use. Failures are logged, not fatal — the
  // sender simply stays unanswered until their next message.
  try {
    const answered = await fallback.handle(
      message,
      replyDeliver,
      availableExamples(settings, fromCrew),
    );
    if (answered && app && typeof app.debug === "function") {
      app.debug("LXMF message answered with the fallback reply");
    }
  } catch (e) {
    if (app && typeof app.error === "function") {
      app.error(`LXMF fallback reply failed: ${e.message}`);
    }
  }
}

module.exports = {
  commands,
  isFromCrew,
  handleMessage,
};
