const test = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_REREQUEST_EVERY_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  watchAnnounceFreshness,
} = require("../plugin/announce-health");

/** EventTarget-based fake transport: dispatches announce events and records path requests. */
function makeTransport() {
  const listeners = [];
  const requested = [];
  return {
    transport: {
      addEventListener: (name, fn) => listeners.push(fn),
      removeEventListener: (name, fn) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
      requestPath: async (hash) => {
        requested.push(Buffer.from(hash).toString("hex"));
      },
    },
    dispatchAnnounce: (hex) => {
      const event = {
        detail: { destinationHash: Buffer.from(hex, "hex") },
      };
      for (const fn of [...listeners]) fn(event);
    },
    requested,
  };
}

function makeRns(transport) {
  return { transport };
}

/** Waits for at least one sweep tick of a fast (test) sweep interval. */
const sweepTick = () => new Promise((resolve) => setTimeout(resolve, 40));

test("re-requests stale crew destinations and throttles repeats", async () => {
  const { transport, dispatchAnnounce, requested } = makeTransport();
  const log = [];
  let now = 1_000_000;
  const crew = ["a".repeat(32), "b".repeat(32)];

  const stop = watchAnnounceFreshness({
    rns: makeRns(transport),
    destinationHashes: crew,
    staleAfterMs: 60_000,
    rerequestEveryMs: 1000,
    sweepIntervalMs: 10,
    now: () => now,
    log: (msg) => log.push(msg),
  });

  try {
    // A fresh announce for the first member keeps it healthy...
    now += 10_000;
    dispatchAnnounce(crew[0]);
    // ...while the second member is never heard. Advance past the staleness
    // window for the unheard member only: the next sweep must re-request
    // the stale member and leave the fresh one alone.
    now += 50_000;
    await sweepTick();
    assert.deepStrictEqual(requested, [crew[1]]);
    assert.ok(
      log.some((m) => m.includes(crew[1]) && m.includes("requesting")),
      "expected a staleness log line",
    );
    assert.ok(
      !log.some((m) => m.includes(crew[0])),
      "fresh member must not be re-requested",
    );
    // Re-requests are throttled while the peer stays stale...
    now += 500;
    await sweepTick();
    assert.strictEqual(requested.length, 1, "throttled re-request");
    // ...but fire again once the rerequest window passes.
    now += 1000;
    await sweepTick();
    assert.deepStrictEqual(requested, [crew[1], crew[1]]);
  } finally {
    stop();
  }
});

test("fresh announces reset staleness", async () => {
  const { transport, dispatchAnnounce, requested } = makeTransport();
  let now = 1_000_000;
  const crew = ["c".repeat(32)];
  const stop = watchAnnounceFreshness({
    rns: makeRns(transport),
    destinationHashes: crew,
    staleAfterMs: 60_000,
    rerequestEveryMs: 1000,
    sweepIntervalMs: 10,
    now: () => now,
    log: () => {},
  });

  try {
    // Announces keep arriving just within the staleness window.
    for (let i = 0; i < 5; i++) {
      now += 59_000;
      dispatchAnnounce(crew[0]);
      await sweepTick();
    }
    assert.strictEqual(requested.length, 0, "no re-requests while fresh");
  } finally {
    stop();
  }
});

test("stop() tears the watchdog down", async () => {
  const { transport, requested } = makeTransport();
  let now = 1_000_000;
  const crew = ["d".repeat(32)];
  const stop = watchAnnounceFreshness({
    rns: makeRns(transport),
    destinationHashes: crew,
    staleAfterMs: 1000,
    rerequestEveryMs: 1000,
    sweepIntervalMs: 10,
    now: () => now,
    log: () => {},
  });
  stop();
  // Well past every window: nothing may fire after teardown.
  now += 3600_000;
  await sweepTick();
  assert.strictEqual(requested.length, 0);
});

test("defaults keep a comfortable margin over peer announce cadences", () => {
  // Peers re-announce every 30 min to a few hours; two hours of silence means
  // the refresh chain has genuinely stalled.
  assert.strictEqual(DEFAULT_STALE_AFTER_MS, 2 * 60 * 60 * 1000);
  assert.strictEqual(DEFAULT_REREQUEST_EVERY_MS, 15 * 60 * 1000);
  assert.strictEqual(DEFAULT_SWEEP_INTERVAL_MS, 60 * 1000);
});

test("an away crew member produces a bounded request rate, no burst", async () => {
  // A crew member out of reach for a long stretch must not cause a request
  // storm: the watchdog re-requests at most once per rerequestEveryMs, and
  // unrelated mesh announces are ignored entirely.
  const { transport, dispatchAnnounce, requested } = makeTransport();
  let now = 1_000_000;
  const crew = ["f".repeat(32)];
  const stop = watchAnnounceFreshness({
    rns: makeRns(transport),
    destinationHashes: crew,
    staleAfterMs: 60_000,
    rerequestEveryMs: 1000,
    sweepIntervalMs: 10,
    now: () => now,
    log: () => {},
  });

  try {
    // Simulate a day away, in accelerated steps: the sweep fires far more
    // often than the throttle allows requests.
    for (let minute = 0; minute < 60; minute += 1) {
      now += 60_000; // one minute passes
      await sweepTick();
    }
    // One request per minute at most (throttle 1000 ms) — and exactly one per
    // elapsed throttle window, never more than one per sweep.
    assert.strictEqual(requested.length, 60);
    for (const hex of requested) assert.strictEqual(hex, crew[0]);

    // Unrelated announces do not refresh anything (and never did).
    requested.length = 0;
    now += 2000; // let the re-request throttle window pass
    dispatchAnnounce("9".repeat(32));
    await sweepTick();
    assert.strictEqual(requested.length, 1, "still stale, still throttled");

    // Crew returns: their announce stops the requests.
    dispatchAnnounce(crew[0]);
    requested.length = 0;
    now += 60_000;
    await sweepTick();
    assert.strictEqual(requested.length, 0, "fresh again after their announce");
  } finally {
    stop();
  }
});

test("missing transport is a safe no-op", () => {
  const stop = watchAnnounceFreshness({
    rns: { transport: null },
    destinationHashes: ["e".repeat(32)],
    log: () => {},
  });
  assert.strictEqual(typeof stop, "function");
  stop();
});
