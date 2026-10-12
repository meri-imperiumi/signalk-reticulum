const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BRIEFING_PLUGIN_ID,
  briefingDataDir,
  briefingAvailable,
  loadBriefing,
  briefMeta,
  briefingLines,
  briefingMarkdown,
  briefingPage,
  fmtUtc,
  fmtAge,
  compass,
  parseUtc,
  isStale,
  conditionsLines,
  micronizeLine,
} = require("../plugin/briefing");
const { commands } = require("../plugin/commands");
const briefing = require("../plugin/commands/briefing");

/** A payload shaped like the briefing plugin's Unified Weather Payload. */
function makePayload(overrides = {}) {
  return {
    metadata: {
      fetchedAt: "2026-10-12T08:00:00.000Z",
      source: "api",
      mode: "here",
    },
    comfortTier: "easy",
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
          {
            timestamp: "2026-10-12T20:00",
            surface: {
              tws: 18,
              twd: 240,
              mslp: 1005,
              gust: 24,
              cloudCover: 90,
            },
            marine: { hsCombined: 1.4, tpCombined: 7 },
          },
        ],
      },
    ],
    metareaBulletin: {
      header: "HIGH SEAS FORECAST",
      issuer: "NWS",
      blocks: [{ text: "GALE WARNING. Winds 30 to 40 kn." }],
    },
    hazardEvents: [
      {
        id: "gdacs-1",
        type: "Earthquake",
        alertLevel: "red",
        title: "M 6.2 nearby",
        distanceNm: 120.4,
        bearingDeg: 45,
      },
    ],
    energyEvents: [
      { type: "surplus", netWh: 2100, endTimestamp: "2026-10-12T14:00:00Z" },
    ],
    celestialNights: [
      {
        timestamp: "2026-10-12T18:00:00Z",
        sunset: "2026-10-12T19:04:00Z",
        sunrise: "2026-10-13T05:31:00Z",
        moonrise: "2026-10-12T22:31:00Z",
        moonset: "2026-10-13T06:12:00Z",
        moonIllumination: 0.402,
      },
    ],
    spaceEvents: [
      {
        kind: "conjunction",
        timestamp: "2026-10-12T19:30:00Z",
        description: "Venus and Jupiter in conjunction: 0.5° apart",
      },
    ],
    ...overrides,
  };
}

/** A fake app serving brief meta from the bus and a config root. */
function makeApp(configRoot, paths = {}) {
  return {
    config: { configPath: configRoot },
    getSelfPath: (selfPath) =>
      selfPath in paths ? { value: paths[selfPath] } : undefined,
  };
}

/** Writes a fake briefing cache layout under a temp dir and cleans up after. */
function withCache(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-"));
  const weather = path.join(
    root,
    "plugin-config-data",
    BRIEFING_PLUGIN_ID,
    "weather",
  );
  fs.mkdirSync(weather, { recursive: true });
  for (const [name, payload] of Object.entries(files)) {
    fs.writeFileSync(path.join(weather, name), JSON.stringify(payload));
  }
  return Promise.resolve(fn(root)).finally(() =>
    fs.rmSync(root, { recursive: true, force: true }),
  );
}

const NOW = new Date("2026-10-12T08:30:00Z");

// --- helpers ----------------------------------------------------------------

test("fmtUtc renders MM-DD HH:MMZ in UTC", () => {
  assert.equal(fmtUtc("2026-10-12T08:05:00.000Z"), "10-12 08:05Z");
  assert.equal(fmtUtc("2026-10-12T08:05"), "10-12 08:05Z");
  assert.equal(fmtUtc("not a date"), "");
  assert.equal(fmtUtc(undefined), "");
});

test("parseUtc reads bare timestamps as UTC", () => {
  assert.equal(parseUtc("2026-10-12T08:05"), parseUtc("2026-10-12T08:05Z"));
});

test("fmtAge renders minutes, hours and days", () => {
  assert.equal(fmtAge("2026-10-12T08:05:00Z", NOW), "25m old");
  assert.equal(fmtAge("2026-10-12T06:00:00Z", NOW), "2h old");
  assert.equal(fmtAge("2026-10-09T08:30:00Z", NOW), "3d old");
  assert.equal(fmtAge("bogus", NOW), "");
});

test("compass renders a 16-point rose", () => {
  assert.equal(compass(0), "N");
  assert.equal(compass(45), "NE");
  assert.equal(compass(225), "SW");
  assert.equal(compass(359), "N");
  assert.equal(compass(undefined), "");
});

test("isStale uses the bus stale flag when present", () => {
  const payload = makePayload();
  assert.equal(isStale(payload, { stale: true }, NOW), true);
  assert.equal(isStale(payload, { stale: false }, NOW), false, "flag wins");
  assert.equal(isStale(payload, {}, NOW), false, "3h here TTL");
  assert.equal(
    isStale(
      makePayload({ metadata: { fetchedAt: "2026-10-11T12:00:00Z" } }),
      {},
      NOW,
    ),
    true,
  );
  assert.equal(
    isStale(
      makePayload({ metadata: { fetchedAt: "2026-10-11T12:00:00Z" } }),
      { route: "Balticcircle" },
      NOW,
    ),
    false,
    "route briefings get the 26h TTL",
  );
});

// --- data dir & cache loading ----------------------------------------------

test("briefingDataDir derives the sibling plugin dir from the config path", () => {
  const app = { config: { configPath: "/data/.signalk" } };
  assert.equal(
    briefingDataDir(app),
    "/data/.signalk/plugin-config-data/signalk-passage-briefing",
  );
});

test("briefingDataDir falls back to walking up from the plugin data dir", () => {
  const app = {
    getDataDirPath: () => "/data/.signalk/plugin-config-data/other-plugin",
  };
  assert.equal(
    briefingDataDir(app),
    "/data/.signalk/plugin-config-data/signalk-passage-briefing",
  );
});

test("briefingDataDir returns null when nothing is derivable", () => {
  assert.equal(briefingDataDir({}), null);
  assert.equal(briefingDataDir(null), null);
});

test("loadBriefing prefers the payload the bus meta points at", () =>
  withCache(
    {
      "here.json": makePayload(),
      "latest-route.json": makePayload({
        metadata: { fetchedAt: "2026-10-11T06:00:00.000Z" },
      }),
    },
    async (root) => {
      const found = await loadBriefing(
        makeApp(root, {
          "navigation.briefing.generatedAt": "2026-10-11T06:00:00.000Z",
        }),
      );
      assert.equal(
        found.payload.metadata.fetchedAt,
        "2026-10-11T06:00:00.000Z",
      );
    },
  ));

test("loadBriefing falls back to the newest cached payload", () =>
  withCache(
    {
      "here.json": makePayload(),
      "latest-route.json": makePayload({
        metadata: { fetchedAt: "2026-10-11T06:00:00.000Z" },
      }),
    },
    async (root) => {
      const found = await loadBriefing(makeApp(root));
      assert.equal(
        found.payload.metadata.fetchedAt,
        "2026-10-12T08:00:00.000Z",
      );
    },
  ));

test("loadBriefing returns null on a boat without the briefing plugin", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-"));
  try {
    assert.equal(await loadBriefing(makeApp(root)), null);
    assert.equal(
      await loadBriefing({ config: { configPath: "/nonexistent" } }),
      null,
    );
    assert.equal(await loadBriefing(null), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("briefingAvailable reports whether the briefing plugin's cache exists", () =>
  withCache({}, async (root) => {
    assert.equal(await briefingAvailable(makeApp(root)), true);
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-"));
    try {
      assert.equal(await briefingAvailable(makeApp(emptyRoot)), false);
      assert.equal(await briefingAvailable(null), false);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  }));

test("briefMeta reads the summary meta off the bus", () => {
  assert.deepEqual(
    briefMeta(
      makeApp(null, {
        "navigation.briefing.route": "Balticcircle",
        "navigation.briefing.comfort": "easy",
        "navigation.briefing.stale": false,
      }),
    ),
    { route: "Balticcircle", comfort: "easy", stale: false },
  );
  assert.deepEqual(briefMeta(null), {
    route: undefined,
    comfort: undefined,
    stale: undefined,
  });
});

// --- the shared body lines ---------------------------------------------------

test("briefingLines renders the full briefing body", () => {
  assert.deepEqual(
    briefingLines({ payload: makePayload(), meta: {}, now: NOW }),
    [
      "Compiled 10-12 08:00Z, 30m old",
      "Conditions here, next 24h",
      "Comfort: easy",
      "Wind: 12-18 kn from WSW, gusts to 24 kn",
      "Waves: max 1.4 m at 7 s",
      "Pressure: 1005 hPa, falling",
      "Cloud cover: up to 90 %",
      "Warnings:",
      "GALE WARNING. Winds 30 to 40 kn.",
      "⚠ Hazards:",
      "red Earthquake: M 6.2 nearby (120 nm NE)",
      "🔋 Energy:",
      "Surplus 2.1 kWh until 10-12 14:00Z",
      "☾ Tonight:",
      "☀ Sun: 10-12 19:04Z↓, 10-13 05:31Z↑",
      "☽ Moon: 10-12 22:31Z↑, 10-13 06:12Z↓, 40% lit",
      "✦ Sky:",
      "10-12 19:30Z Venus and Jupiter in conjunction: 0.5° apart",
    ],
  );
});

test("briefingLines marks a stale compile and names the route", () => {
  const payload = makePayload({
    metadata: { fetchedAt: "2026-10-09T08:00:00.000Z" },
  });
  const lines = briefingLines({
    payload,
    meta: { route: "Balticcircle" },
    now: NOW,
  });
  assert.equal(lines[0], "Compiled 10-09 08:00Z, 3d old (stale)");
  assert.equal(lines[1], "Route: Balticcircle");
});

test("briefingLines omits sections the payload has no data for", () => {
  const payload = makePayload({
    metareaBulletin: undefined,
    hazardEvents: [],
    energyEvents: [],
    celestialNights: [],
    spaceEvents: [],
    comfortTier: null,
  });
  const lines = briefingLines({ payload, meta: {}, now: NOW });
  assert.ok(!lines.includes("Warnings:"));
  assert.ok(!lines.includes("⚠ Hazards:"));
  assert.ok(!lines.includes("🔋 Energy:"));
  assert.ok(!lines.includes("☾ Tonight:"));
  assert.ok(!lines.includes("✦ Sky:"));
  assert.ok(!lines.some((line) => line.startsWith("Comfort:")));
});

test("conditionsLines falls back to the payload's own window when forecasts slid past", () => {
  const payload = makePayload();
  const lines = conditionsLines(payload, new Date("2026-10-13T00:00:00Z"));
  assert.ok(lines.some((line) => line.startsWith("Wind:")));
});

test("micronizeLine turns section labels into headers and colors hazards", () => {
  assert.equal(micronizeLine("Warnings:"), ">Warnings");
  assert.equal(micronizeLine("⚠ Hazards:"), ">⚠ Hazards");
  assert.equal(micronizeLine("🔋 Energy:"), ">🔋 Energy");
  assert.equal(
    micronizeLine("red Earthquake: M 6.2 nearby (120 nm NE)"),
    "`F900red`f Earthquake: M 6.2 nearby (120 nm NE)",
  );
  assert.equal(
    micronizeLine("orange Severe storm: rising (30 nm N)"),
    "`Faa0orange`f Severe storm: rising (30 nm N)",
  );
  assert.equal(
    micronizeLine("Wind: 12-18 kn from SW"),
    "Wind: 12-18 kn from SW",
  );
});

// --- the two renderers -------------------------------------------------------

test("briefingMarkdown renders the Markdown LXMF reply", () => {
  assert.equal(
    briefingMarkdown({ payload: makePayload(), meta: {}, now: NOW }),
    [
      "**Passage briefing**",
      "",
      "Compiled 10-12 08:00Z, 30m old",
      "Conditions here, next 24h",
      "**Comfort:** easy",
      "**Wind:** 12-18 kn from WSW, gusts to 24 kn",
      "**Waves:** max 1.4 m at 7 s",
      "**Pressure:** 1005 hPa, falling",
      "**Cloud cover:** up to 90 %",
      "**Warnings**",
      "GALE WARNING. Winds 30 to 40 kn.",
      "⚠ **Hazards**",
      "**red Earthquake:** M 6.2 nearby (120 nm NE)",
      "🔋 **Energy**",
      "Surplus 2.1 kWh until 10-12 14:00Z",
      "☾ **Tonight**",
      "☀ **Sun:** 10-12 19:04Z↓, 10-13 05:31Z↑",
      "☽ **Moon:** 10-12 22:31Z↑, 10-13 06:12Z↓, 40% lit",
      "✦ **Sky**",
      "10-12 19:30Z Venus and Jupiter in conjunction: 0.5° apart",
    ].join("\n"),
  );
});

test("briefingPage renders micron headers and colors", () => {
  const page = briefingPage({ payload: makePayload(), meta: {}, now: NOW });
  assert.ok(page.startsWith(">Passage briefing\n\n"));
  assert.ok(page.includes("\n>Warnings\nGALE WARNING. Winds 30 to 40 kn.\n"));
  assert.ok(
    page.includes("\n`F900red`f Earthquake: M 6.2 nearby (120 nm NE)\n"),
  );
  assert.ok(!page.includes("\nWarnings:"));
});

test("briefingPage colors a stale compile amber", () => {
  const payload = makePayload({
    metadata: { fetchedAt: "2026-10-09T08:00:00.000Z" },
  });
  const page = briefingPage({ payload, meta: {}, now: NOW });
  assert.ok(page.includes("`Faa0(stale)`f"), page);
});

test("both renderers stay quiet when nothing is cached", () => {
  assert.equal(
    briefingMarkdown({}),
    "**Passage briefing**\n\nNo briefing available",
  );
  assert.equal(
    briefingMarkdown({ payload: {} }),
    "**Passage briefing**\n\nNo briefing available",
  );
  assert.equal(
    briefingPage({}),
    ">Passage briefing\n\nNo briefing available\n",
  );
});

// --- the command -------------------------------------------------------------

test("the briefing command is registered and crew-only", () => {
  assert.equal(commands.briefing, briefing);
  assert.equal(briefing.crewOnly, true);
  assert.equal(briefing.example, "Briefing");
});

test("briefing accepts 'Briefing', 'Brief' and casing variants", () => {
  assert.equal(briefing.accept({ content: "briefing" }), true);
  assert.equal(briefing.accept({ content: "  Brief " }), true);
  assert.equal(briefing.accept({ content: "BRIEF" }), true);
  assert.equal(briefing.accept({ content: "status" }), false);
  assert.equal(briefing.accept({ content: "" }), false);
  assert.equal(briefing.accept({ content: "briefing now" }), false);
  assert.equal(briefing.accept(null), false);
});

test("the briefing command replies with the cached briefing", () =>
  withCache({ "here.json": makePayload() }, async (root) => {
    const calls = [];
    const deliver = async (destHash, title, content, linkId) => {
      calls.push({ destHash, title, content, linkId });
    };
    await briefing.handle(
      { content: "briefing", sourceHash: new Uint8Array(16).fill(9) },
      {},
      deliver,
      makeApp(root),
      "link-1",
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.startsWith("**Passage briefing**\n\nCompiled "));
    assert.equal(calls[0].title, "");
    assert.equal(calls[0].linkId, "link-1");
  }));

test("the briefing command stays quiet without a cached briefing", () =>
  withCache({}, async (root) => {
    const calls = [];
    await briefing.handle(
      { content: "briefing", sourceHash: new Uint8Array(16).fill(9) },
      {},
      async (...args) => calls.push(args),
      makeApp(root),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], "**Passage briefing**\n\nNo briefing available");
  }));
