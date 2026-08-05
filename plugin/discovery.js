/**
 * Auto-discovery of mesh service nodes (LXMF propagation, RFed federation)
 * from transport announces, selecting the closest (fewest-hops) candidate.
 *
 * A service node announces its destination under a fixed aspect (e.g.
 * `lxmf.propagation`); the transport attaches the aspect's 10-byte `name_hash`
 * (`SHA-256(aspect)[:10]`) to every `announce` event detail, so callers can
 * aspect-filter announces without a deep import of the transport or a separate
 * announce-handler registry.
 *
 * {@link discoverClosestNode} watches those events. To genuinely honour
 * "closest" rather than just "first heard", it waits a short grace window after
 * the *first* matching announce (so a closer node that announces near-simultaneously
 * wins), keeps the fewest-hops candidate seen during the window, then fires
 * `onSelect` once with that candidate and stops listening — so the caller does a
 * single one-shot setup with no mid-stream switching to reason about. If no
 * matching announce is ever heard, nothing happens (there is simply nothing to
 * connect to yet).
 *
 * @file discovery.js
 */

const crypto = require("node:crypto");
const { toHex } = require("@reticulum/core");

/** Injected for testability; defaults to the real @reticulum/core encoder. */
const deps = { toHex };

/**
 * Default grace window (milliseconds) after the first matching announce during
 * which {@link discoverClosestNode} keeps tracking a closer candidate before
 * locking in. Service nodes announce infrequently (Reticulum's default cadence
 * is ~30 minutes), so this mainly catches near-simultaneous announces; it is
 * short enough not to noticeably delay startup once a node has been heard.
 */
const DEFAULT_GRACE_MS = 15000;

/**
 * Aspects announced by an RFed *federation node* (the relay a client subscribes
 * to and publishes through). Every rfed *client* (this plugin included, and
 * other boats) announces `rfed.delivery`, so that aspect is deliberately
 * excluded — otherwise every other boat on the channel would look like a
 * federation node. A real federation node announces one or more of these
 * server-side aspects, so matching any of them reliably identifies a node.
 */
const RFED_NODE_ASPECTS = [
  "rfed.channel.subscribe",
  "rfed.channel.unsubscribe",
  "rfed.channel.publish",
  "rfed.channel.pull",
  "rfed.notify.register",
  "rfed.notify.unregister",
  "rfed.notify",
];

/** Aspect an LXMF propagation node announces its store-and-forward service on. */
const PROPAGATION_ASPECT = "lxmf.propagation";

/**
 * Computes the 10-byte announce `name_hash` for an aspect —
 * `SHA-256(aspect UTF-8 bytes)[:10]` — as a 20-character lowercase hex string.
 * Matches the `nameHash` the transport attaches to each `announce` event
 * detail (and `@reticulum/core`'s async `aspectNameHash`), so a caller can
 * aspect-filter announces synchronously and without a deep import.
 *
 * @param {string} aspect
 * @returns {string}
 */
function aspectNameHashHex(aspect) {
  return crypto
    .createHash("sha256")
    .update(aspect, "utf8")
    .digest("hex")
    .slice(0, 20);
}

/**
 * Lowercase-hex `name_hash`es for every aspect in `aspects`.
 *
 * @param {string[]} aspects
 * @returns {string[]}
 */
function aspectNameHashesHex(aspects) {
  return aspects.map(aspectNameHashHex);
}

/**
 * Renders a hop count for log lines (`Infinity`/unknown → "unknown distance").
 *
 * @param {number} hops
 * @returns {string}
 */
function hopsLabel(hops) {
  return Number.isFinite(hops) ? `${hops} hop(s)` : "unknown distance";
}

/**
 * Watches transport announces whose aspect `name_hash` is in `nameHashesHex`
 * and, after a short grace window, selects the closest (fewest-hops)
 * candidate, calling `onSelect(hex, hops)` exactly once and then detaching.
 *
 * The grace window starts on the *first* matching announce and lasts `graceMs`
 * (default {@link DEFAULT_GRACE_MS}); during it, every matching announce
 * updates the running closest (fewest `packet.hops`; ties keep the first
 * seen). When the grace window elapses, `onSelect` fires with the closest
 * candidate (or not at all when none was heard) and the listener detaches, so
 * the caller does a single one-shot setup. `hops` is the announce's hop count,
 * or `Infinity` when the announce carried none (so it never beats a
 * finite-hop candidate but is still selectable when it is the only one).
 *
 * Returns an unsubscribe that detaches the listener and clears the grace timer
 * (no-op safe). When the node lacks a transport/`addEventListener`, selection
 * is impossible and a no-op unsubscribe is returned.
 *
 * @param {object} options
 * @param {{transport?:EventTarget}|null|undefined} options.rns
 * @param {string[]} options.nameHashesHex - Lowercase-hex aspect name_hashes to match.
 * @param {(hex:string, hops:number)=>void} options.onSelect
 * @param {number} [options.graceMs] - Grace window; defaults to {@link DEFAULT_GRACE_MS}.
 * @param {(...args:any[])=>void} [options.log]
 * @returns {() => void}
 */
function discoverClosestNode({
  rns,
  nameHashesHex,
  onSelect,
  graceMs,
  log = () => {},
}) {
  const noop = () => {};
  if (
    !rns ||
    !rns.transport ||
    typeof rns.transport.addEventListener !== "function" ||
    typeof rns.transport.removeEventListener !== "function"
  ) {
    return noop;
  }
  const targets = new Set(
    (Array.isArray(nameHashesHex) ? nameHashesHex : [nameHashesHex]).map((h) =>
      String(h || "").toLowerCase(),
    ),
  );
  if (targets.size === 0 || typeof onSelect !== "function") {
    return noop;
  }
  const wait =
    typeof graceMs === "number" && graceMs >= 0 ? graceMs : DEFAULT_GRACE_MS;
  let closest = null; // { hex, hops }
  let graceTimer = null;
  let detached = false;

  const detach = () => {
    if (detached) {
      return;
    }
    detached = true;
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    try {
      rns.transport.removeEventListener("announce", onAnnounce);
    } catch {
      /* best effort */
    }
  };
  const finish = () => {
    graceTimer = null;
    detach();
    if (closest) {
      log(
        `Selected closest discovered node ${closest.hex} (${hopsLabel(closest.hops)})`,
      );
      onSelect(closest.hex, closest.hops);
    } else {
      log("Discovery grace window elapsed with no matching announce");
    }
  };
  const onAnnounce = (event) => {
    const detail = (event && event.detail) || {};
    const nameHash = detail.nameHash;
    if (!nameHash) {
      return;
    }
    let nameHashHex;
    try {
      nameHashHex = deps.toHex(nameHash).toLowerCase();
    } catch {
      return; // nameHash wasn't a Uint8Array; ignore the malformed event.
    }
    if (!targets.has(nameHashHex)) {
      return;
    }
    const hex = deps.toHex(detail.destinationHash).toLowerCase();
    const rawHops = detail.packet && Number(detail.packet.hops);
    const hops = Number.isFinite(rawHops) ? rawHops : Number.POSITIVE_INFINITY;
    if (!closest || hops < closest.hops) {
      const first = !closest;
      closest = { hex, hops };
      log(
        `Discovered ${first ? "a" : "a closer"} matching node ${hex} (${hopsLabel(hops)})`,
      );
      if (graceTimer == null) {
        // Start the grace window on the first matching announce; a closer
        // candidate seen within it replaces `closest` before `finish` locks in.
        graceTimer = setTimeout(finish, wait);
      }
    }
  };
  rns.transport.addEventListener("announce", onAnnounce);
  return detach;
}

module.exports = {
  deps,
  DEFAULT_GRACE_MS,
  RFED_NODE_ASPECTS,
  PROPAGATION_ASPECT,
  aspectNameHashHex,
  aspectNameHashesHex,
  discoverClosestNode,
};
