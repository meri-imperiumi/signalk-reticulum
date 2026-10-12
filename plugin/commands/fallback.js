/**
 * Fallback reply for direct LXMF messages that match no command: a one-line
 * explanation of what the node is plus the commands the sender may use, so
 * that somebody who found the node in their LXMF client doesn't wait for a
 * human that isn't there. Crew who typo a command get the same treatment,
 * with the crew-only commands listed.
 *
 * Replies are rate limited per sender — one per hour — both to keep two
 * automated nodes from answering each other back and forth and to save
 * airtime on a busy mesh. Mirrors the `signalk-meshtastic` fallback.
 *
 * @file commands/fallback.js
 */

const { toHex } = require("@reticulum/core");

/** How often the same sender may draw a fallback reply. */
const REPLY_INTERVAL_MS = 60 * 60 * 1000;

/** Sender hex hash → instant of the last fallback reply. */
const lastReply = new Map();

function prune(now) {
  lastReply.forEach((sent, sender) => {
    if (now - sent >= REPLY_INTERVAL_MS) {
      lastReply.delete(sender);
    }
  });
}

/**
 * Renders the fallback reply line.
 *
 * @param {string[]} examples - The commands the sender may use.
 * @returns {string}
 */
function replyText(examples) {
  return `Automated boat node, nobody reads this. Commands: ${examples.join(", ")}`;
}

/**
 * Answers an unmatched message at most once per {@link REPLY_INTERVAL_MS} per
 * sender. The rate-limit entry is recorded *before* the send and rolled back
 * when delivery throws, so a failed reply does not burn the sender's hourly
 * slot.
 *
 * @param {{sourceHash?:Uint8Array}|null|undefined} message
 * @param {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null, opts?:object)=>Promise<unknown>} deliver
 * @param {string[]} examples - The commands the sender may use.
 * @param {Date} [now]
 * @returns {Promise<boolean>} Whether a reply was sent.
 */
async function handle(message, deliver, examples, now = Date.now()) {
  if (!message || !message.sourceHash) {
    return false;
  }
  prune(now);
  const sender = toHex(message.sourceHash);
  if (lastReply.has(sender)) {
    return false;
  }
  lastReply.set(sender, now);
  try {
    await deliver(sender, "", replyText(examples));
    return true;
  } catch (error) {
    lastReply.delete(sender);
    throw error;
  }
}

/** Clears the rate-limit state; for tests. */
function reset() {
  lastReply.clear();
}

module.exports = {
  handle,
  replyText,
  reset,
  REPLY_INTERVAL_MS,
};
