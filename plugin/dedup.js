/**
 * Inbound LXMF message deduplication.
 *
 * The same LXMF message can arrive more than once: a sender's client may
 * retry a send, and the router dispatches every arrival path — over the
 * arrival link, as an opportunistic packet, via a propagation-node sync and
 * via the embedded node's in-process local delivery — without cross-path
 * deduplication. Each dispatch re-runs command handling (re-toggling the
 * switch and re-replying), so a command sent once can produce several
 * identical "OK, …" replies.
 *
 * LXMF message ids are content-derived (SHA-256 over the signed part, LXMF.md
 * §5.5), so every wire copy of one message — whatever path it took — shares
 * one id. A bounded "recently seen" filter collapses those copies into the
 * first arrival, the same way LXMF clients (Sideband, Nomad Network)
 * deduplicate inbound messages by message hash.
 *
 * Everything here is pure so it can be unit-tested in isolation.
 *
 * @file dedup.js
 */

/** Number of message ids remembered by default. A boat's node handles a few
 * messages a minute at most, so 256 entries spans hours of traffic while
 * staying trivially small (one hex string per message). */
const DEFAULT_CAPACITY = 256;

/**
 * Builds a bounded "recently seen" filter: `seen(key)` returns `true` the
 * first time a key is sighted and `false` for every repeat, remembering the
 * most recent {@link DEFAULT_CAPACITY} keys (least-recently-used evicted).
 *
 * @param {number} [capacity=DEFAULT_CAPACITY] - Maximum keys remembered.
 * @returns {(key:string)=>boolean}
 */
function makeRecentFilter(capacity = DEFAULT_CAPACITY) {
  const cap =
    Number.isFinite(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY;
  /** Insertion-ordered map: oldest entry is the first key. */
  const entries = new Map();
  return function seen(key) {
    if (entries.has(key)) {
      // Refresh the LRU position so a repeatedly re-delivered message (a
      // peer syncing the same propagation copy on every pass) never ages out
      // of the filter while copies keep arriving.
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return false;
    }
    entries.set(key, Date.now());
    if (entries.size > cap) {
      entries.delete(entries.keys().next().value);
    }
    return true;
  };
}

/**
 * Derives the deduplication key for an inbound LXMF message: the hex-encoded
 * message id, which is identical for every delivery of the same message.
 * Returns `null` when the message carries no id (a synthetic dispatch) — the
 * caller must then treat the message as new rather than risk dropping a
 * distinct message that happens to share source and content.
 *
 * @param {{messageId?:Uint8Array|null}|null|undefined} message
 * @param {(bytes:Uint8Array)=>string} toHex
 * @returns {string|null}
 */
function messageKey(message, toHex) {
  const id = message?.messageId;
  if (!id?.length) {
    return null;
  }
  return toHex(id);
}

module.exports = {
  DEFAULT_CAPACITY,
  makeRecentFilter,
  messageKey,
};
