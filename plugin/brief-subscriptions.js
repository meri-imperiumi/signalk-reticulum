/**
 * Daily briefing subscriptions: crew members who asked — over the mesh, with
 * a `Subscribe briefing` message (commands/briefing-subscribe.js) — to have
 * the boat's passage briefing pushed to them once a day, instead of having
 * to remember to ask with `Briefing`.
 *
 * The push is triggered by generation, not by a clock: whenever the
 * `signalk-passage-briefing` plugin compiles a fresh payload it stamps
 * `navigation.briefing.generatedAt` on the bus, and subscribers then receive
 * exactly that compile — maximally fresh by construction, with the render's
 * compile-stamp and staleness marker telling the truth about its age. Two
 * persisted per-subscriber gates keep that contract across restarts: the
 * once-per-local-day gate (the calendar day of the last send) keeps the four
 * daily cron compiles and any internet-transition oneshots from flooding
 * anyone, and the compile gate (the `fetchedAt` of the last delivered
 * compile) keeps a restart from ever re-delivering a compile the subscriber
 * already received, however stale the cache still is. Stores from before the
 * compile gate existed bridge on their persisted send instant until the
 * first post-upgrade send stamps the compile, so the upgrade itself does not
 * repeat an older day's briefing. Together a compile is delivered at most
 * once per subscriber and at most one briefing goes out per local day —
 * restarts neither lose, double, nor repeat.
 *
 * Subscriptions persist as JSON in the plugin data dir
 * (`brief-subscriptions.json`), written atomically. Deliberately plugin-data,
 * not plugin settings: the crew manage their subscriptions from the mesh, and
 * the plugin configuration belongs to the admin UI — a message-driven write
 * into the settings would clobber concurrent UI edits.
 *
 * Dispatch resolves each stored subscription against the currently configured
 * crew (the same {@link module:plugin/notifications} resolution every command
 * uses), so removing a crew member from the configuration also stops their
 * pushes even if their subscription entry lingers.
 *
 * This module is free of any Reticulum coupling — the caller supplies the
 * `deliver` callback — so the day gate and the fan-out are unit-testable in
 * isolation with a fake clock and a recording deliverer.
 *
 * @file brief-subscriptions.js
 */

const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");

const { effectiveCrew } = require("./notifications");
const {
  briefMeta,
  briefingLines,
  briefingMarkdown,
  loadBriefing,
} = require("./briefing");

/** The subscription store, kept next to the node's persisted peer data. */
const FILE_NAME = "brief-subscriptions.json";

/**
 * Resolves the subscription store path from the plugin data directory, or
 * `null` when the server exposes no data directory (older Signal K servers).
 *
 * @param {{getDataDirPath?: () => string}|null|undefined} app
 * @returns {string|null} Absolute file path, or null when unavailable.
 */
function subscriptionsPath(app) {
  if (!app || typeof app.getDataDirPath !== "function") {
    return null;
  }
  let dir;
  try {
    dir = app.getDataDirPath();
  } catch {
    return null;
  }
  if (!dir) {
    return null;
  }
  return path.join(dir, FILE_NAME);
}

/**
 * Loads the subscription store. A missing or corrupted file behaves as an
 * empty store — subscriptions are a convenience, and a lost store only costs
 * one duplicate briefing per subscriber at worst (the day gate resets).
 *
 * @param {{getDataDirPath?: () => string}|null|undefined} app
 * @returns {Promise<{file: string|null, subscriptions: object}>} The store
 *   path (null when storage is unavailable) and the entries keyed by the
 *   subscriber's `lxmf.delivery` destination hash (lowercase hex).
 */
async function loadSubscriptions(app) {
  const file = subscriptionsPath(app);
  if (!file) {
    return { file: null, subscriptions: {} };
  }
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { file, subscriptions: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    const subscriptions =
      parsed &&
      typeof parsed === "object" &&
      parsed.subscriptions &&
      typeof parsed.subscriptions === "object"
        ? parsed.subscriptions
        : {};
    return { file, subscriptions };
  } catch {
    return { file, subscriptions: {} };
  }
}

/**
 * Persists the subscription store atomically (temporary file + rename), so a
 * crash mid-write can never leave a truncated store behind.
 *
 * @param {string} file - Store path from {@link loadSubscriptions}.
 * @param {object} subscriptions - The entries to persist.
 * @returns {Promise<void>}
 */
async function saveSubscriptions(file, subscriptions) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(
    tmp,
    `${JSON.stringify({ version: 1, subscriptions }, null, 2)}\n`,
  );
  await rename(tmp, file);
}

/**
 * The local calendar-day key ("YYYY-MM-DD" in the server's timezone) used as
 * the once-per-day gate: a subscriber is sent at most one briefing per local
 * day, on the first compile that lands after their last sent day.
 *
 * @param {Date|number|string} now - Instant to key (injectable for tests).
 * @returns {string} The day key.
 */
function todayKey(now) {
  const date = now instanceof Date ? now : new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Sends the briefing to every subscribed, currently-configured crew member
 * who has not had it today and for whom the cached compile is new: a compile
 * already delivered to them (its `fetchedAt` at or after the last one sent)
 * is never re-delivered, however many restarts or day rollovers pass. The
 * briefing payload is loaded once and rendered once — every recipient gets
 * the identical compile — and the store is marked per successfully delivered
 * recipient only, so a failed delivery retries on the next compile instead
 * of costing the subscriber their daily briefing. When the briefing plugin
 * has nothing cached (or its payload renders no lines) nobody is sent or
 * marked: there is nothing fresh to say, and the next compile will retry.
 *
 * @param {object} [params]
 * @param {object} [params.settings] - Plugin settings (the `crew` list is
 *   resolved through {@link effectiveCrew}).
 * @param {(destinationHashHex: string, title: string, content: string,
 *   linkId?: Uint8Array|null, opts?: object) => Promise<object>} params.deliver
 *   - The outbound LXMF sender.
 * @param {{getDataDirPath?: () => string, getSelfPath?: (p: string) =>
 *   unknown}} params.app - The Signal K app, for the store and the briefing
 *   plugin's cache and bus meta.
 * @param {Date} [params.now] - The dispatch instant (injectable for tests).
 * @param {(...args:any[]) => void} [params.log] - Debug-style logger.
 * @returns {Promise<number>} The number of briefings sent.
 */
async function dispatchBriefings({
  settings,
  deliver,
  app,
  now = new Date(),
  log = () => {},
} = {}) {
  if (!deliver) {
    return 0;
  }
  const crew = effectiveCrew(settings?.crew);
  if (crew.length === 0) {
    return 0;
  }
  const { file, subscriptions } = await loadSubscriptions(app);
  if (!file) {
    return 0;
  }
  const crewByHash = new Map(
    crew.map((member) => [member.destinationHash, member]),
  );
  const today = todayKey(now);
  // The crew and day pre-filter stays ahead of the briefing load, so the
  // common everyone-is-current case costs no cache read and no log noise.
  const awaiting = Object.keys(subscriptions).filter((hash) => {
    const entry = subscriptions[hash];
    return (
      crewByHash.has(hash) &&
      entry &&
      typeof entry === "object" &&
      entry.lastSentDay !== today
    );
  });
  if (awaiting.length === 0) {
    return 0;
  }
  const briefing = await loadBriefing(app);
  if (!briefing) {
    log("Daily briefing skipped: the briefing plugin has nothing cached");
    return 0;
  }
  // The compile gate: a compile a subscriber already received — the last
  // sent fetchedAt at or after the cached one (equal is the common case;
  // newer also covers a cache rollback) — is never re-delivered. This is
  // what makes a restart with a stale cache a no-op instead of a repeat of
  // an older day's briefing. Stores written before the gate existed carry
  // only the send instant; it is the best-known floor, because a dispatch
  // delivers the compile then newest — so a cached compile at or before the
  // last send was already received too.
  const pending = awaiting.filter((hash) => {
    const entry = subscriptions[hash];
    const floor =
      typeof entry.lastSentFetchedAt === "string"
        ? entry.lastSentFetchedAt
        : entry.lastSentAt;
    return !(typeof floor === "string" && floor >= briefing.fetchedAt);
  });
  if (pending.length === 0) {
    return 0;
  }
  const meta = briefMeta(app);
  const lines = briefingLines({ payload: briefing.payload, meta, now });
  if (lines.length === 0) {
    log("Daily briefing skipped: the cached payload renders no lines");
    return 0;
  }
  const content = briefingMarkdown({ payload: briefing.payload, meta, now });
  let sent = 0;
  for (const hash of pending) {
    try {
      await deliver(hash, "Daily briefing", content, null, { markdown: true });
      subscriptions[hash].lastSentDay = today;
      subscriptions[hash].lastSentAt = now.toISOString();
      subscriptions[hash].lastSentFetchedAt = briefing.fetchedAt;
      sent += 1;
    } catch (e) {
      log(`Daily briefing delivery to ${hash} failed: ${e.message}`);
    }
  }
  if (sent > 0) {
    try {
      await saveSubscriptions(file, subscriptions);
    } catch (e) {
      log(`Failed to persist briefing subscription state: ${e.message}`);
    }
  }
  return sent;
}

// Dispatches are serialized: a generatedAt delta and the startup catch-up can
// race, and the once-per-day gate must be read-then-written by one dispatch
// at a time or a tight compile pair could double-send before the store lands.
let dispatchChain = Promise.resolve();

/**
 * Queues a {@link dispatchBriefings} run behind any in-flight one. Failures
 * do not break the chain — the next dispatch starts from a settled state.
 *
 * @param {object} [params] - See {@link dispatchBriefings}.
 * @returns {Promise<number>} The number of briefings sent.
 */
function queueBriefingDispatch(params = {}) {
  const run = dispatchChain.then(() => dispatchBriefings(params));
  dispatchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

module.exports = {
  FILE_NAME,
  subscriptionsPath,
  loadSubscriptions,
  saveSubscriptions,
  todayKey,
  dispatchBriefings,
  queueBriefingDispatch,
};
