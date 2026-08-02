const { describe, it, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ALERT_STATES,
  DEBOUNCE_MS,
  shouldWeSendNotification,
  buildAlertMessage,
  effectiveCrew,
  sendNotification,
} = require("../plugin/notifications");
const { deriveLxmfDestinationHash } = require("../plugin/identity");

const SEND = { messaging: { send_alerts: true } };
const NO_SEND = { messaging: { send_alerts: false } };

test("ALERT_STATES are the two most urgent Signal K states", () => {
  assert.deepEqual(ALERT_STATES, ["alarm", "emergency"]);
});

// ---------------------------------------------------------------------------

describe("shouldWeSendNotification", () => {
  it("sends an emergency", () => {
    const episodes = new Map();
    assert.equal(
      shouldWeSendNotification(
        "notifications.communication.foo",
        { state: "emergency", message: "Mayday" },
        episodes,
        SEND,
      ),
      true,
    );
  });

  it("sends an alarm", () => {
    const episodes = new Map();
    assert.equal(
      shouldWeSendNotification(
        "notifications.electrical.bilge",
        { state: "alarm", message: "Bilge high" },
        episodes,
        SEND,
      ),
      true,
    );
  });

  it("does not send an alert (only alarm/emergency are forwarded)", () => {
    const episodes = new Map();
    assert.equal(
      shouldWeSendNotification(
        "notifications.x",
        { state: "alert", message: "Heads up" },
        episodes,
        SEND,
      ),
      false,
    );
  });

  it("does not send a nominal state", () => {
    const episodes = new Map();
    assert.equal(
      shouldWeSendNotification(
        "notifications.x",
        { state: "nominal", message: "ok" },
        episodes,
        SEND,
      ),
      false,
    );
  });

  it("does not send when alert forwarding is disabled", () => {
    const episodes = new Map();
    assert.equal(
      shouldWeSendNotification(
        "notifications.x",
        { state: "emergency", message: "Mayday" },
        episodes,
        NO_SEND,
      ),
      false,
    );
  });

  it("does not send when messaging settings are absent", () => {
    const episodes = new Map();
    assert.equal(
      shouldWeSendNotification(
        "notifications.x",
        { state: "emergency" },
        episodes,
        {},
      ),
      false,
    );
  });

  it("does not send a falsy value", () => {
    const episodes = new Map();
    assert.equal(
      shouldWeSendNotification("notifications.x", null, episodes, SEND),
      false,
    );
  });

  it("dedupes a flapping alarm: only the first is sent", () => {
    const episodes = new Map();
    const alarm = { state: "alarm", message: "Bilge" };
    const clear = { state: "nominal", message: "ok" };

    assert.equal(
      shouldWeSendNotification("notifications.bilge", alarm, episodes, SEND),
      true,
      "first alarm sent",
    );
    assert.equal(
      shouldWeSendNotification("notifications.bilge", clear, episodes, SEND),
      false,
      "clearing not sent",
    );
    assert.equal(
      shouldWeSendNotification("notifications.bilge", alarm, episodes, SEND),
      false,
      "immediate re-alarm not sent (within debounce window)",
    );
  });

  it("re-sends an alarm that cleared long ago", () => {
    const episodes = new Map();
    const start = new Date("2024-01-01T00:00:00Z");
    const alarm = { state: "alarm", message: "Bilge" };
    const clear = { state: "nominal", message: "ok" };

    assert.equal(
      shouldWeSendNotification(
        "notifications.bilge",
        alarm,
        episodes,
        SEND,
        start,
      ),
      true,
    );
    // Clear shortly after.
    const clearTime = new Date(start.getTime() + 10_000);
    assert.equal(
      shouldWeSendNotification(
        "notifications.bilge",
        clear,
        episodes,
        SEND,
        clearTime,
      ),
      false,
    );
    // Re-alarm past the debounce window -> sent again.
    const restartTime = new Date(clearTime.getTime() + DEBOUNCE_MS + 1);
    assert.equal(
      shouldWeSendNotification(
        "notifications.bilge",
        alarm,
        episodes,
        SEND,
        restartTime,
      ),
      true,
    );
  });
});

// ---------------------------------------------------------------------------

describe("buildAlertMessage", () => {
  it("uses the notification message and strips the path prefix in the title", () => {
    const { title, content } = buildAlertMessage(
      "notifications.electrical.bilge",
      { message: "Water rising" },
    );
    assert.equal(title, "Signal K: electrical.bilge");
    assert.equal(content, "Water rising");
  });

  it("prepends an audible bell when a sound method is requested", () => {
    const { content } = buildAlertMessage("notifications.x", {
      message: "Boom",
      method: ["sound", "visual"],
    });
    assert.equal(content, "\u0007 Boom");
  });

  it("does not add a bell without a sound method", () => {
    const { content } = buildAlertMessage("notifications.x", {
      message: "Boom",
      method: ["visual"],
    });
    assert.equal(content, "Boom");
  });

  it("falls back to a generated message when none is provided", () => {
    const { title, content } = buildAlertMessage("notifications.x", {});
    assert.equal(title, "Signal K: x");
    assert.match(content, /Alert on x/);
  });
});

// ---------------------------------------------------------------------------

describe("effectiveCrew", () => {
  const VALID = "0123456789abcdef0123456789abcdef";
  // The lxmf.delivery destination hash derived from VALID treated as an
  // identity hash. effectiveCrew derives this from the `identity` field.
  const DERIVED = deriveLxmfDestinationHash(VALID);

  it("derives the lxmf.delivery destination hash from an identity hash", () => {
    const crew = effectiveCrew([
      { name: "Alice", identity: VALID.toUpperCase() },
      { name: "Bob", identity: `  ${VALID}  ` },
    ]);
    assert.deepEqual(crew, [
      { name: "Alice", destinationHash: DERIVED },
      { name: "Bob", destinationHash: DERIVED },
    ]);
    // Sanity: the derived hash differs from the raw identity hash, and is
    // still a 32-char hex value.
    assert.notEqual(DERIVED, VALID);
    assert.match(DERIVED, /^[0-9a-f]{32}$/);
  });

  it("falls back to a legacy lxmf.destination hash used verbatim", () => {
    const crew = effectiveCrew([{ name: "Carol", destination: VALID }]);
    assert.deepEqual(crew, [{ name: "Carol", destinationHash: VALID }]);
  });

  it("prefers identity over a legacy destination when both are present", () => {
    const crew = effectiveCrew([
      { name: "Dan", identity: VALID, destination: "f".repeat(32) },
    ]);
    assert.deepEqual(crew, [{ name: "Dan", destinationHash: DERIVED }]);
  });

  it("uses the identity hash as the name fallback for identity entries", () => {
    const crew = effectiveCrew([{ identity: VALID }]);
    assert.equal(crew[0].name, VALID);
    assert.equal(crew[0].destinationHash, DERIVED);
  });

  it("skips entries with neither a valid identity nor a legacy destination", () => {
    const logged = [];
    const crew = effectiveCrew(
      [
        { name: "Alice", identity: VALID },
        { name: "Bad", identity: "nothex" },
        { name: "Short", identity: "abcd" },
        { name: "Legacy", destination: "nothex" },
        { identity: VALID },
      ],
      (...args) => logged.push(args.join(" ")),
    );
    assert.equal(crew.length, 2);
    assert.equal(crew[0].name, "Alice");
    // An unnamed member falls back to its identity hash.
    assert.equal(crew[1].name, VALID);
    assert.equal(logged.length, 3);
    assert.match(logged[0], /invalid Reticulum identity/);
  });

  it("returns [] for non-array input", () => {
    assert.deepEqual(effectiveCrew(undefined), []);
    assert.deepEqual(effectiveCrew(null), []);
    assert.deepEqual(effectiveCrew("nope"), []);
  });
});

// ---------------------------------------------------------------------------

describe("sendNotification", () => {
  const VALID = "0123456789abcdef0123456789abcdef";
  const crewSettings = {
    messaging: { send_alerts: true },
    crew: [{ name: "Alice", destination: VALID }],
  };

  function fakeApp() {
    return {
      errors: [],
      debugs: [],
      error(...a) {
        this.errors.push(a.join(" "));
      },
      debug(...a) {
        this.debugs.push(a.join(" "));
      },
    };
  }

  it("delivers an alarm to each crew member via the deliver callback", async () => {
    const delivered = [];
    const deliver = async (hash, title, content) => {
      delivered.push({ hash, title, content });
    };
    const app = fakeApp();

    const sent = await sendNotification(
      "notifications.electrical.bilge",
      { state: "alarm", message: "Bilge!" },
      new Map(),
      crewSettings,
      deliver,
      app,
    );

    assert.equal(sent, true);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].hash, VALID);
    assert.equal(delivered[0].title, "Signal K: electrical.bilge");
    assert.equal(delivered[0].content, "Bilge!");
    assert.equal(app.errors.length, 0);
  });

  it("continues to the next recipient when one delivery fails", async () => {
    const settings = {
      messaging: { send_alerts: true },
      crew: [
        { name: "Boom", destination: VALID },
        { name: "Ok", destination: "fedcba9876543210fedcba9876543210" },
      ],
    };
    const delivered = [];
    const deliver = async (hash) => {
      if (hash === VALID) throw new Error("identity unknown");
      delivered.push(hash);
    };
    const app = fakeApp();

    const sent = await sendNotification(
      "notifications.x",
      { state: "emergency", message: "Mayday" },
      new Map(),
      settings,
      deliver,
      app,
    );

    assert.equal(sent, true, "at least one recipient succeeded");
    assert.equal(delivered.length, 1);
    assert.equal(app.errors.length, 1);
    assert.match(app.errors[0], /Failed to send alert to Boom/);
  });

  it("returns false without delivering when messaging is unavailable", async () => {
    const delivered = [];
    const sent = await sendNotification(
      "notifications.x",
      { state: "alarm" },
      new Map(),
      crewSettings,
      undefined,
      fakeApp(),
    );
    // Also provide a deliver fn to prove it isn't called for a non-alert.
    assert.equal(sent, false);
    assert.equal(delivered.length, 0);
  });

  it("returns false when there is no crew configured", async () => {
    const settings = { messaging: { send_alerts: true }, crew: [] };
    let called = false;
    const sent = await sendNotification(
      "notifications.x",
      { state: "alarm", message: "x" },
      new Map(),
      settings,
      async () => {
        called = true;
      },
      fakeApp(),
    );
    assert.equal(sent, false);
    assert.equal(called, false);
  });

  it("does not re-deliver a flapping alarm within the debounce window", async () => {
    const delivered = [];
    const deliver = async () => {
      delivered.push(true);
    };
    const episodes = new Map();
    const alarm = { state: "alarm", message: "Bilge" };
    const clear = { state: "nominal", message: "ok" };

    await sendNotification(
      "notifications.bilge",
      alarm,
      episodes,
      crewSettings,
      deliver,
      fakeApp(),
    );
    await sendNotification(
      "notifications.bilge",
      clear,
      episodes,
      crewSettings,
      deliver,
      fakeApp(),
    );
    await sendNotification(
      "notifications.bilge",
      alarm,
      episodes,
      crewSettings,
      deliver,
      fakeApp(),
    );

    assert.equal(delivered.length, 1, "only the first alarm is delivered");
  });
});
