const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FILE_NAME,
  loadSubscriptions,
  saveSubscriptions,
  subscriptionsPath,
  todayKey,
  dispatchBriefings,
} = require("../plugin/brief-subscriptions");
const { commands, handleMessage } = require("../plugin/commands");
const briefingSubscribe = require("../plugin/commands/briefing-subscribe");
const briefingUnsubscribe = require("../plugin/commands/briefing-unsubscribe");
const { BRIEFING_PLUGIN_ID } = require("../plugin/briefing");
const { deriveLxmfDestinationHash } = require("../plugin/identity");

// The subscriber's LXMF source hash (their lxmf.delivery destination).
const SOURCE = new Uint8Array(16).fill(5);
const SOURCE_HEX = Buffer.from(SOURCE).toString("hex");
const OTHER_HEX = "b".repeat(32);

/** A payload shaped like the briefing plugin's Unified Weather Payload. */
function makePayload(overrides = {}) {
  return {
    metadata: {
      fetchedAt: "2026-10-12T08:00:00.000Z",
      source: "api",
      mode: "here",
    },
    waypoints: [
      {
        lat: 60.1,
        lon: 21.5,
        forecasts: [
          {
            timestamp: "2026-10-12T08:00",
            surface: {
              tws: 12,
              twd: 225,
              mslp: 1010,
              gust: 18,
              cloudCover: 40,
            },
            marine: { hsCombined: 1.0, tpCombined: 6 },
          },
        ],
      },
    ],
    ...overrides,
  };
}

/**
 * A temp directory laid out like the server config dir: the briefing
 * plugin's cache under `plugin-config-data/` and this plugin's data dir next
 * to it, so both the briefing cache and the subscription store resolve
 * exactly the way they do in production.
 */
function makeEnv(payload) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brief-subs-"));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  if (payload !== null) {
    const weather = path.join(
      root,
      "plugin-config-data",
      BRIEFING_PLUGIN_ID,
      "weather",
    );
    fs.mkdirSync(weather, { recursive: true });
    fs.writeFileSync(
      path.join(weather, "here.json"),
      JSON.stringify(payload === undefined ? makePayload() : payload),
    );
  }
  const app = {
    config: { configPath: root },
    getDataDirPath: () =>
      path.join(root, "plugin-config-data", "signalk-reticulum"),
    debug: () => {},
  };
  return { root, app, cleanup };
}

/** A recording deliver callback. Rejects for hashes in `failFor`. */
function makeDeliver(failFor = new Set()) {
  const calls = [];
  const deliver = async (destHash, title, content, linkId, opts) => {
    if (failFor.has(destHash)) {
      throw new Error("mesh is down");
    }
    calls.push({ destHash, title, content, linkId, opts });
  };
  return { deliver, calls };
}

/** Crew settings matching `hashes` by legacy destination entry. */
function crewOf(...hashes) {
  return { crew: hashes.map((destination) => ({ name: "Crew", destination })) };
}

function makeMessage(content, sourceHash = SOURCE) {
  return { content, sourceHash };
}

// --- day key ----------------------------------------------------------------

test("todayKey renders the local calendar day and rolls over at midnight", () => {
  const evening = new Date(2026, 9, 12, 23, 59, 59);
  const morning = new Date(2026, 9, 13, 0, 0, 1);
  assert.equal(todayKey(evening), "2026-10-12");
  assert.equal(todayKey(morning), "2026-10-13");
  assert.notEqual(todayKey(evening), todayKey(morning));
});

// --- store ------------------------------------------------------------------

test("subscriptionsPath resolves inside the plugin data dir", () => {
  const { app, cleanup } = makeEnv(null);
  try {
    assert.equal(
      subscriptionsPath(app),
      path.join(app.getDataDirPath(), FILE_NAME),
    );
  } finally {
    cleanup();
  }
});

test("subscriptionsPath returns null without a data dir", () => {
  assert.equal(subscriptionsPath({}), null);
  assert.equal(subscriptionsPath(null), null);
  assert.equal(subscriptionsPath({ getDataDirPath: () => undefined }), null);
  assert.equal(
    subscriptionsPath({
      getDataDirPath: () => {
        throw new Error("boom");
      },
    }),
    null,
  );
});

test("loadSubscriptions treats a missing or corrupted store as empty", async () => {
  const { app, cleanup } = makeEnv(null);
  try {
    assert.deepEqual(await loadSubscriptions(app), {
      file: subscriptionsPath(app),
      subscriptions: {},
    });
    fs.mkdirSync(path.dirname(subscriptionsPath(app)), { recursive: true });
    fs.writeFileSync(subscriptionsPath(app), "{not json");
    const loaded = await loadSubscriptions(app);
    assert.deepEqual(loaded.subscriptions, {});
  } finally {
    cleanup();
  }
});

test("saveSubscriptions writes atomically and round-trips", async () => {
  const { app, cleanup } = makeEnv(null);
  try {
    const file = subscriptionsPath(app);
    await saveSubscriptions(file, { [SOURCE_HEX]: { subscribedAt: "iso" } });
    assert.equal(fs.existsSync(`${file}.tmp`), false, "no temp file left");
    const { subscriptions } = await loadSubscriptions(app);
    assert.deepEqual(subscriptions[SOURCE_HEX], { subscribedAt: "iso" });
  } finally {
    cleanup();
  }
});

// --- subscribe command ------------------------------------------------------

test("the subscribe and unsubscribe commands are registered and crew-only", () => {
  assert.equal(commands.briefingSubscribe, briefingSubscribe);
  assert.equal(commands.briefingUnsubscribe, briefingUnsubscribe);
  assert.equal(briefingSubscribe.crewOnly, true);
  assert.equal(briefingUnsubscribe.crewOnly, true);
});

test("subscribe accepts brief/briefing subscriptions", () => {
  for (const text of [
    "Subscribe brief",
    "subscribe briefing",
    "SUB BRIEFING",
    "sub brief",
    "  Subscribe   Briefing  ",
  ]) {
    assert.equal(briefingSubscribe.accept(makeMessage(text)), true, text);
  }
  for (const text of [
    "subscribe",
    "unsubscribe brief",
    "briefing",
    "subscribe status",
    "logo design ideas",
    "",
  ]) {
    assert.equal(briefingSubscribe.accept(makeMessage(text)), false, text);
  }
  assert.equal(briefingSubscribe.accept(null), false);
  assert.equal(briefingSubscribe.accept({ content: undefined }), false);
});

test("unsubscribe accepts brief/briefing cancellations", () => {
  for (const text of [
    "Unsubscribe brief",
    "unsubscribe briefing",
    "unsub brief",
  ]) {
    assert.equal(briefingUnsubscribe.accept(makeMessage(text)), true, text);
  }
  assert.equal(
    briefingUnsubscribe.accept(makeMessage("subscribe brief")),
    false,
  );
  assert.equal(briefingUnsubscribe.accept(makeMessage("unsubscribe")), false);
});

test("subscribe stores the sender and confirms", async () => {
  const { app, cleanup } = makeEnv(null);
  try {
    const { deliver, calls } = makeDeliver();
    await briefingSubscribe.handle(
      makeMessage("Subscribe brief"),
      {},
      deliver,
      app,
    );
    const { subscriptions } = await loadSubscriptions(app);
    assert.ok(subscriptions[SOURCE_HEX].subscribedAt, "entry persisted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].destHash, SOURCE_HEX);
    assert.match(calls[0].content, /Subscribed/);
  } finally {
    cleanup();
  }
});

test("subscribe is idempotent and keeps the original entry", async () => {
  const { app, cleanup } = makeEnv(null);
  try {
    const { deliver, calls } = makeDeliver();
    await briefingSubscribe.handle(
      makeMessage("Subscribe brief"),
      {},
      deliver,
      app,
    );
    const first = await loadSubscriptions(app);
    await briefingSubscribe.handle(
      makeMessage("Subscribe brief"),
      {},
      deliver,
      app,
    );
    const second = await loadSubscriptions(app);
    assert.deepEqual(second.subscriptions, first.subscriptions);
    assert.match(calls[1].content, /Already subscribed/);
  } finally {
    cleanup();
  }
});

test("subscribe without plugin storage explains itself", async () => {
  const { deliver, calls } = makeDeliver();
  await briefingSubscribe.handle(
    makeMessage("Subscribe brief"),
    {},
    deliver,
    {},
  );
  assert.match(calls[0].content, /unavailable/);
});

// --- unsubscribe command ----------------------------------------------------

test("unsubscribe removes the sender and confirms", async () => {
  const { app, cleanup } = makeEnv(null);
  try {
    const file = subscriptionsPath(app);
    await saveSubscriptions(file, { [SOURCE_HEX]: { subscribedAt: "iso" } });
    const { deliver, calls } = makeDeliver();
    await briefingUnsubscribe.handle(
      makeMessage("Unsubscribe brief"),
      {},
      deliver,
      app,
    );
    const { subscriptions } = await loadSubscriptions(app);
    assert.equal(subscriptions[SOURCE_HEX], undefined);
    assert.match(calls[0].content, /Unsubscribed/);
  } finally {
    cleanup();
  }
});

test("unsubscribe without a subscription just says so", async () => {
  const { app, cleanup } = makeEnv(null);
  try {
    const { deliver, calls } = makeDeliver();
    await briefingUnsubscribe.handle(
      makeMessage("Unsubscribe brief"),
      {},
      deliver,
      app,
    );
    assert.match(calls[0].content, /Not subscribed/);
    assert.equal(
      fs.existsSync(subscriptionsPath(app)),
      false,
      "store untouched",
    );
  } finally {
    cleanup();
  }
});

test("the dispatcher routes subscribe and unsubscribe for crew", async () => {
  const { app, cleanup } = makeEnv(null);
  try {
    const settings = crewOf(SOURCE_HEX);
    const { deliver, calls } = makeDeliver();
    await handleMessage(
      makeMessage("Subscribe briefing"),
      settings,
      deliver,
      app,
    );
    await handleMessage(
      makeMessage("Unsubscribe briefing"),
      settings,
      deliver,
      app,
    );
    assert.match(calls[0].content, /Subscribed/);
    assert.match(calls[1].content, /Unsubscribed/);
  } finally {
    cleanup();
  }
});

// --- dispatch ---------------------------------------------------------------

const MORNING = new Date(2026, 9, 12, 6, 30, 0);

test("dispatch sends the fresh compile once per subscriber per day", async () => {
  const { app, cleanup } = makeEnv();
  try {
    const file = subscriptionsPath(app);
    await saveSubscriptions(file, {
      [SOURCE_HEX]: { subscribedAt: "iso" },
      [OTHER_HEX]: { subscribedAt: "iso" },
    });
    const settings = crewOf(SOURCE_HEX, OTHER_HEX);
    const { deliver, calls } = makeDeliver();
    const sent = await dispatchBriefings({
      settings,
      deliver,
      app,
      now: MORNING,
    });
    assert.equal(sent, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].title, "Daily briefing");
    assert.equal(calls[0].opts.markdown, true);
    assert.ok(calls[0].content.startsWith("**Passage briefing**"));
    // The once-per-day gate: a second compile the same day sends nobody.
    const again = await dispatchBriefings({
      settings,
      deliver,
      app,
      now: new Date(2026, 9, 12, 14, 15, 0),
    });
    assert.equal(again, 0);
    assert.equal(calls.length, 2);
    // And a new day does not re-deliver the same compile either — what is
    // new to the subscriber is the compile, not the calendar date.
    const nextDay = await dispatchBriefings({
      settings,
      deliver,
      app,
      now: new Date(2026, 9, 13, 6, 30, 0),
    });
    assert.equal(nextDay, 0);
    assert.equal(calls.length, 2);
    // The delivered compile's fetchedAt is persisted for restart safety.
    const { subscriptions } = await loadSubscriptions(app);
    assert.equal(
      subscriptions[SOURCE_HEX].lastSentFetchedAt,
      "2026-10-12T08:00:00.000Z",
    );
    assert.ok(subscriptions[SOURCE_HEX].lastSentAt);
    // A genuinely fresh compile goes out on the new day.
    const weather = path.join(
      app.config.configPath,
      "plugin-config-data",
      BRIEFING_PLUGIN_ID,
      "weather",
    );
    fs.writeFileSync(
      path.join(weather, "latest-20261013.json"),
      JSON.stringify(
        makePayload({
          metadata: {
            fetchedAt: "2026-10-13T05:00:00.000Z",
            source: "api",
            mode: "here",
          },
        }),
      ),
    );
    const fresh = await dispatchBriefings({
      settings,
      deliver,
      app,
      now: new Date(2026, 9, 13, 6, 30, 0),
    });
    assert.equal(fresh, 2);
    assert.equal(calls.length, 4);
    const updated = await loadSubscriptions(app);
    assert.equal(
      updated.subscriptions[SOURCE_HEX].lastSentFetchedAt,
      "2026-10-13T05:00:00.000Z",
      "the newest send's compile wins",
    );
    assert.equal(
      updated.subscriptions[SOURCE_HEX].lastSentDay,
      todayKey(new Date(2026, 9, 13, 6, 30, 0)),
    );
  } finally {
    cleanup();
  }
});

test("a restart never re-delivers a compile the subscriber already received", async () => {
  const { app, cleanup } = makeEnv();
  try {
    await saveSubscriptions(subscriptionsPath(app), {
      [SOURCE_HEX]: { subscribedAt: "iso" },
    });
    const settings = crewOf(SOURCE_HEX);
    const { deliver, calls } = makeDeliver();
    assert.equal(
      await dispatchBriefings({ settings, deliver, app, now: MORNING }),
      1,
    );
    // Days later the same compile is still the freshest cached one — a
    // restart's catch-up dispatch (or the replayed generatedAt) must not
    // push it again, whatever the calendar says.
    const daysLater = new Date(2026, 9, 15, 7, 0, 0);
    assert.equal(
      await dispatchBriefings({ settings, deliver, app, now: daysLater }),
      0,
    );
    assert.equal(calls.length, 1);
    // The same restart delivers a compile that is new to the subscriber.
    const weather = path.join(
      app.config.configPath,
      "plugin-config-data",
      BRIEFING_PLUGIN_ID,
      "weather",
    );
    fs.writeFileSync(
      path.join(weather, "latest-20261015.json"),
      JSON.stringify(
        makePayload({
          metadata: {
            fetchedAt: "2026-10-15T05:00:00.000Z",
            source: "api",
            mode: "here",
          },
        }),
      ),
    );
    assert.equal(
      await dispatchBriefings({ settings, deliver, app, now: daysLater }),
      1,
    );
    assert.equal(calls.length, 2);
    // And the next restart does not repeat the fresh compile either.
    assert.equal(
      await dispatchBriefings({
        settings,
        deliver,
        app,
        now: new Date(2026, 9, 16, 6, 0, 0),
      }),
      0,
    );
    assert.equal(calls.length, 2);
  } finally {
    cleanup();
  }
});

test("a pre-compile-gate store does not re-deliver the compile its last send covered", async () => {
  const { app, cleanup } = makeEnv();
  try {
    // A store written before the compile gate existed: only the send day and
    // instant. The 08:00Z compile was delivered by that 09:00Z send.
    await saveSubscriptions(subscriptionsPath(app), {
      [SOURCE_HEX]: {
        subscribedAt: "iso",
        lastSentDay: "2026-10-12",
        lastSentAt: "2026-10-12T09:00:00.000Z",
      },
    });
    const settings = crewOf(SOURCE_HEX);
    const { deliver, calls } = makeDeliver();
    // The next day's first dispatch (the upgrade's catch-up) must not
    // re-deliver the compile the last send already covered.
    assert.equal(
      await dispatchBriefings({
        settings,
        deliver,
        app,
        now: new Date(2026, 9, 13, 6, 30, 0),
      }),
      0,
    );
    assert.equal(calls.length, 0);
    // But a compile newer than that send still goes out.
    const weather = path.join(
      app.config.configPath,
      "plugin-config-data",
      BRIEFING_PLUGIN_ID,
      "weather",
    );
    fs.writeFileSync(
      path.join(weather, "latest-20261013.json"),
      JSON.stringify(
        makePayload({
          metadata: {
            fetchedAt: "2026-10-13T05:00:00.000Z",
            source: "api",
            mode: "here",
          },
        }),
      ),
    );
    assert.equal(
      await dispatchBriefings({
        settings,
        deliver,
        app,
        now: new Date(2026, 9, 13, 6, 30, 0),
      }),
      1,
    );
    assert.equal(calls.length, 1);
    const { subscriptions } = await loadSubscriptions(app);
    assert.equal(
      subscriptions[SOURCE_HEX].lastSentFetchedAt,
      "2026-10-13T05:00:00.000Z",
      "the first send seeds the compile gate",
    );
  } finally {
    cleanup();
  }
});

test("dispatch only reaches currently configured crew", async () => {
  const { app, cleanup } = makeEnv();
  try {
    await saveSubscriptions(subscriptionsPath(app), {
      [SOURCE_HEX]: { subscribedAt: "iso" },
      [OTHER_HEX]: { subscribedAt: "iso" },
    });
    const { deliver, calls } = makeDeliver();
    // Only SOURCE_HEX is still configured; the OTHER_HEX subscription lingers.
    const sent = await dispatchBriefings({
      settings: crewOf(SOURCE_HEX),
      deliver,
      app,
      now: MORNING,
    });
    assert.equal(sent, 1);
    assert.equal(calls[0].destHash, SOURCE_HEX);
  } finally {
    cleanup();
  }
});

test("dispatch reaches identity-configured crew by derived destination", async () => {
  const { app, cleanup } = makeEnv();
  try {
    // The crew member is configured by identity hash; the subscription was
    // stored under the derived lxmf.delivery destination they send from.
    const identityHex = "c".repeat(32);
    const destination = deriveLxmfDestinationHash(identityHex);
    await saveSubscriptions(subscriptionsPath(app), {
      [destination]: { subscribedAt: "iso" },
    });
    const { deliver, calls } = makeDeliver();
    const sent = await dispatchBriefings({
      settings: { crew: [{ name: "Skipper", identity: identityHex }] },
      deliver,
      app,
      now: MORNING,
    });
    assert.equal(sent, 1);
    assert.equal(calls[0].destHash, destination);
  } finally {
    cleanup();
  }
});

test("dispatch skips when the briefing plugin has nothing cached", async () => {
  const { app, cleanup } = makeEnv(null);
  try {
    await saveSubscriptions(subscriptionsPath(app), {
      [SOURCE_HEX]: { subscribedAt: "iso" },
    });
    const { deliver, calls } = makeDeliver();
    const sent = await dispatchBriefings({
      settings: crewOf(SOURCE_HEX),
      deliver,
      app,
      now: MORNING,
    });
    assert.equal(sent, 0);
    assert.equal(calls.length, 0);
    // Nobody was marked, so a later compile still delivers the day's briefing.
    const root = app.config.configPath;
    const weather = path.join(
      root,
      "plugin-config-data",
      BRIEFING_PLUGIN_ID,
      "weather",
    );
    fs.mkdirSync(weather, { recursive: true });
    fs.writeFileSync(
      path.join(weather, "here.json"),
      JSON.stringify(makePayload()),
    );
    const later = await dispatchBriefings({
      settings: crewOf(SOURCE_HEX),
      deliver,
      app,
      now: MORNING,
    });
    assert.equal(later, 1);
  } finally {
    cleanup();
  }
});

test("dispatch skips payloads that render no lines", async () => {
  const { app, cleanup } = makeEnv(makePayload({ waypoints: [] }));
  try {
    await saveSubscriptions(subscriptionsPath(app), {
      [SOURCE_HEX]: { subscribedAt: "iso" },
    });
    const { deliver, calls } = makeDeliver();
    const sent = await dispatchBriefings({
      settings: crewOf(SOURCE_HEX),
      deliver,
      app,
      now: MORNING,
    });
    assert.equal(sent, 0);
    assert.equal(calls.length, 0);
    const { subscriptions } = await loadSubscriptions(app);
    assert.equal(subscriptions[SOURCE_HEX].lastSentDay, undefined);
  } finally {
    cleanup();
  }
});

test("a failed delivery retries while the others keep their send", async () => {
  const { app, cleanup } = makeEnv();
  try {
    await saveSubscriptions(subscriptionsPath(app), {
      [SOURCE_HEX]: { subscribedAt: "iso" },
      [OTHER_HEX]: { subscribedAt: "iso" },
    });
    const settings = crewOf(SOURCE_HEX, OTHER_HEX);
    const failing = makeDeliver(new Set([SOURCE_HEX]));
    const sent = await dispatchBriefings({
      settings,
      deliver: failing.deliver,
      app,
      now: MORNING,
    });
    assert.equal(sent, 1);
    const { subscriptions } = await loadSubscriptions(app);
    assert.equal(
      subscriptions[SOURCE_HEX].lastSentDay,
      undefined,
      "not marked",
    );
    assert.equal(subscriptions[OTHER_HEX].lastSentDay, todayKey(MORNING));
    // The next compile retries exactly the failed subscriber.
    const retry = makeDeliver();
    const retried = await dispatchBriefings({
      settings,
      deliver: retry.deliver,
      app,
      now: new Date(2026, 9, 12, 14, 15, 0),
    });
    assert.equal(retried, 1);
    assert.deepEqual(
      retry.calls.map((c) => c.destHash),
      [SOURCE_HEX],
    );
  } finally {
    cleanup();
  }
});

test("dispatch is a no-op without subscribers, crew, deliver or storage", async () => {
  const { app, cleanup } = makeEnv();
  try {
    const { deliver, calls } = makeDeliver();
    assert.equal(
      await dispatchBriefings({ settings: {}, deliver, app, now: MORNING }),
      0,
      "no subscribers",
    );
    await saveSubscriptions(subscriptionsPath(app), {
      [SOURCE_HEX]: { subscribedAt: "iso" },
    });
    assert.equal(
      await dispatchBriefings({
        settings: {},
        deliver,
        app,
        now: MORNING,
      }),
      0,
      "no crew configured",
    );
    assert.equal(
      await dispatchBriefings({
        settings: crewOf(SOURCE_HEX),
        deliver: null,
        app,
        now: MORNING,
      }),
      0,
      "no deliverer",
    );
    assert.equal(
      await dispatchBriefings({
        settings: crewOf(SOURCE_HEX),
        deliver,
        app: {},
        now: MORNING,
      }),
      0,
      "no storage",
    );
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});
