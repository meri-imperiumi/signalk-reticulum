/**
 * Announce-freshness watchdog for crew destinations.
 *
 * Why this exists: outbound LXMF traffic (telemetry, replies) is encrypted to
 * the recipient's *current* forward-secrecy ratchet key, which we only ever
 * learn from their announces (or a path-response carrying the same data). A
 * multi-hop topology where the intermediate transport node only forwards
 * announces it accepts as new can leave our view of a peer's ratchet (and
 * path) stale for hours — we then keep encrypting to the old ratchet and the
 * peer silently drops every message. Nothing in the transport self-heals
 * this: `requestPathAuto` and the pre-link path wait both short-circuit while
 * `hasPath()` is true, so a stale-but-present route blocks re-solicitation
 * forever (until a process restart, which is exactly the "restart makes
 * telemetry work again for a while" pattern).
 *
 * The watchdog listens to the transport's `announce` events, remembers the
 * last time each crew destination was heard, and when a member goes stale
 * sends an ungated `path?` request for them. The path-response announce that
 * comes back refreshes the route *and* the remembered identity/ratchet in one
 * shot, restarting delivery without a restart. Re-requests are throttled per
 * destination while the peer stays stale.
 *
 * This module is intentionally free of Signal K coupling so it can be
 * unit-tested in isolation; the caller decides which destinations to watch
 * (the configured crew) and passes the live transport in.
 *
 * @file announce-health.js
 */

/**
 * Default milliseconds after which an unrefreshed crew destination is
 * considered stale and re-requested. Peers on the mesh re-announce every
 * 30 minutes to a few hours (Reticulum's own reference cadence is 30 min,
 * Sideband defaults to a few hours), so a couple of hours without hearing
 * one means the refresh chain has stalled.
 * @type {number}
 */
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Default minimum spacing between repeated `path?` requests for the same
 * stale destination (throttle so a long-stale peer is solicited a few times
 * per hour, not on every sweep).
 * @type {number}
 */
const DEFAULT_REREQUEST_EVERY_MS = 15 * 60 * 1000;

/**
 * Sweep interval for the staleness check.
 * @type {number}
 */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Starts the announce-freshness watchdog.
 *
 * @param {object} options
 * @param {object} options.rns - The Reticulum instance (uses `rns.transport`).
 * @param {string[]} options.destinationHashes - Hex destination hashes to
 *   watch (the configured crew's `lxmf.delivery` hashes).
 * @param {number} [options.staleAfterMs] - Staleness threshold; defaults to
 *   {@link DEFAULT_STALE_AFTER_MS}.
 * @param {number} [options.rerequestEveryMs] - Re-request throttle; defaults
 *   to {@link DEFAULT_REREQUEST_EVERY_MS}.
 * @param {number} [options.sweepIntervalMs] - Staleness sweep interval;
 *   defaults to {@link DEFAULT_SWEEP_INTERVAL_MS} (injectable for tests).
 * @param {() => number} [options.now] - Clock, for tests.
 * @param {(...args: any[]) => void} [options.log] - Debug logger.
 * @returns {() => void} stop — removes the listener and clears the timer.
 */
function watchAnnounceFreshness({
  rns,
  destinationHashes,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  rerequestEveryMs = DEFAULT_REREQUEST_EVERY_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  now = () => Date.now(),
  log = () => {},
}) {
  const transport = rns && rns.transport;
  const watched = new Set(
    Array.isArray(destinationHashes)
      ? destinationHashes.filter((h) => typeof h === "string" && h)
      : [],
  );
  if (!transport || typeof transport.requestPath !== "function") {
    return () => {};
  }

  /** Last time an announce was ingested per destination hex (ms epoch). */
  const lastHeard = new Map();
  /** Last time we sent a re-request per destination hex (ms epoch). */
  const lastRerequest = new Map();

  const onAnnounce = (event) => {
    const hash = event && event.detail && event.detail.destinationHash;
    if (!hash) return;
    const hex =
      typeof hash === "string" ? hash : Buffer.from(hash).toString("hex");
    // Only track watched destinations: a busy mesh announces thousands of
    // unrelated destinations and the map must not grow with it.
    if (!watched.has(hex)) return;
    lastHeard.set(hex, now());
  };
  transport.addEventListener("announce", onAnnounce);

  const sweep = () => {
    const t = now();
    for (const hex of watched) {
      const heardAt = lastHeard.get(hex) ?? 0;
      if (t - heardAt <= staleAfterMs) continue;
      const requestedAt = lastRerequest.get(hex) ?? 0;
      if (t - requestedAt < rerequestEveryMs) continue;
      lastRerequest.set(hex, t);
      const agoMin = heardAt
        ? `${Math.round((t - heardAt) / 60000)} min`
        : "never (since plugin start)";
      log(
        `No announce heard for ${hex} for ${agoMin}; requesting a fresh ` +
          "path (refreshes route and ratchet so LXMF delivery can recover)",
      );
      transport.requestPath(Buffer.from(hex, "hex")).catch((e) => {
        log(`Path request for ${hex} failed: ${e.message}`);
      });
    }
  };
  const timer = setInterval(sweep, sweepIntervalMs);
  timer?.unref?.();

  return () => {
    clearInterval(timer);
    try {
      transport.removeEventListener("announce", onAnnounce);
    } catch {
      /* best effort */
    }
  };
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_REREQUEST_EVERY_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  watchAnnounceFreshness,
};
