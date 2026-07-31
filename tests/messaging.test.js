const test = require("node:test");
const assert = require("node:assert/strict");

const { deps, setupMessaging, makeDeliverer, makeTelemetryDeliverer } =
  require("../plugin/messaging");

/** A fake LXMRouter that records init/announce/send calls. */
class FakeLxmRouter {
  constructor(identity, rns) {
    this.identity = identity;
    this.rns = rns;
    this.initCalls = 0;
    this.announceCalls = [];
    this.sent = [];
    this.deliveryDest = {
      destinationHash: new Uint8Array(16).fill(7),
      // init() enables forward-secrecy ratchets on the delivery destination;
      // mirror that so setupMessaging leaving them enabled is observable.
      ratchetsEnabled: true,
      ratchets: [
        {
          privateKey: new Uint8Array(32).fill(1),
          publicKey: new Uint8Array(32).fill(2),
        },
      ],
    };
  }
  async init() {
    this.initCalls += 1;
  }
  async announce(name) {
    this.announceCalls.push(name);
  }
  startAnnouncingCalls = [];
  async startAnnouncing(name, options = {}) {
    this.startAnnouncingCalls.push({ name, options });
  }
  stopAnnouncingCalls = 0;
  stopAnnouncing() {
    this.stopAnnouncingCalls += 1;
  }
  async send(message, identity, linkId) {
    this.sent.push({ message, identity, linkId });
  }
}

/** A fake LXMessage that just records its constructor options. */
class FakeLXMessage {
  constructor(options) {
    this.options = options;
  }
}

const REAL_DEPS = { ...deps };

test("setupMessaging inits the router and announces the display name", async () => {
  deps.LXMRouter = FakeLxmRouter;
  deps.toHex = (bytes) => Buffer.from(bytes).toString("hex");
  const logs = [];

  const router = await setupMessaging(
    {},
    "IDENTITY",
    { displayName: "Boat" },
    (...a) => logs.push(a.join(" ")),
  );

  assert.equal(router.initCalls, 1);
  assert.deepEqual(router.announceCalls, ["Boat"]);
  assert.ok(logs.some((l) => /Announced LXMF destination/.test(l)));

  Object.assign(deps, REAL_DEPS);
});

test("setupMessaging logs but does not throw when announce fails", async () => {
  deps.LXMRouter = class extends FakeLxmRouter {
    async announce() {
      throw new Error("nope");
    }
  };
  deps.toHex = () => "00";
  const logs = [];

  const router = await setupMessaging({}, {}, { displayName: "Boat" }, (...a) =>
    logs.push(a.join(" ")),
  );

  assert.ok(router, "router still returned");
  assert.ok(logs.some((l) => /Failed to announce LXMF destination/.test(l)));

  Object.assign(deps, REAL_DEPS);
});

test("setupMessaging skips announce when no display name is given", async () => {
  deps.LXMRouter = FakeLxmRouter;

  const router = await setupMessaging({}, {}, {});

  assert.equal(router.announceCalls.length, 0);
  Object.assign(deps, REAL_DEPS);
});

test("setupMessaging periodically re-announces when an interval is given", async () => {
  deps.LXMRouter = FakeLxmRouter;
  deps.toHex = (bytes) => Buffer.from(bytes).toString("hex");
  const logs = [];

  const router = await setupMessaging(
    {},
    {},
    { displayName: "Boat", announceIntervalMs: 30 * 60 * 1000 },
    (...a) => logs.push(a.join(" ")),
  );

  // startAnnouncing replaces the one-shot announce entirely.
  assert.deepEqual(router.announceCalls, []);
  assert.equal(router.startAnnouncingCalls.length, 1, "re-announce started");
  assert.deepEqual(router.startAnnouncingCalls[0], {
    name: "Boat",
    options: { intervalMs: 30 * 60 * 1000 },
  });
  assert.ok(
    logs.some((l) => /re-announcing every 1800s/.test(l)),
    "re-announce cadence logged",
  );

  Object.assign(deps, REAL_DEPS);
});

test("setupMessaging falls back to a one-shot announce when the interval is 0", async () => {
  deps.LXMRouter = FakeLxmRouter;
  deps.toHex = () => "00";

  const router = await setupMessaging(
    {},
    {},
    { displayName: "Boat", announceIntervalMs: 0 },
  );

  assert.deepEqual(router.announceCalls, ["Boat"], "one-shot announce used");
  assert.equal(
    router.startAnnouncingCalls.length,
    0,
    "re-announce not started",
  );

  Object.assign(deps, REAL_DEPS);
});

test("setupMessaging keeps forward-secrecy ratchets enabled so ratchet-encrypted inbound messages decrypt", async () => {
  deps.LXMRouter = FakeLxmRouter;
  deps.toHex = () => "00";

  const router = await setupMessaging({}, {}, { displayName: "Boat" });

  assert.equal(
    router.deliveryDest.ratchetsEnabled,
    true,
    "ratchets left enabled on the delivery destination",
  );
  assert.ok(
    Array.isArray(router.deliveryDest.ratchets) &&
      router.deliveryDest.ratchets.length > 0,
    "ratchet ring left intact on the delivery destination",
  );

  Object.assign(deps, REAL_DEPS);
});

test("makeDeliverer builds and sends an LXMessage via the router", async () => {
  const router = new FakeLxmRouter({}, {});
  const identity = { id: "me" };
  deps.LXMessage = FakeLXMessage;
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  const deliver = makeDeliverer(router, identity);
  await deliver("0123456789abcdef0123456789abcdef", "Title", "Body");

  assert.equal(router.sent.length, 1);
  const { message, identity: sentIdentity } = router.sent[0];
  assert.equal(sentIdentity, identity);
  assert.deepEqual(message.options, {
    sourceHash: router.deliveryDest.destinationHash,
    destinationHash: Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
    title: "Title",
    content: "Body",
  });

  Object.assign(deps, REAL_DEPS);
});

test("makeTelemetryDeliverer builds an LXMessage carrying FIELD_TELEMETRY with an integer field key", async () => {
  const router = new FakeLxmRouter({}, {});
  const identity = { id: "me" };
  deps.LXMessage = FakeLXMessage;
  deps.FIELD_TELEMETRY = 0x02;
  deps.FIELD_ICON_APPEARANCE = 0x04;
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  const deliverTelemetry = makeTelemetryDeliverer(router, identity);
  const packed = new Uint8Array([1, 2, 3]);
  await deliverTelemetry("0123456789abcdef0123456789abcdef", packed);

  assert.equal(router.sent.length, 1);
  const { message, identity: sentIdentity } = router.sent[0];
  assert.equal(sentIdentity, identity);
  assert.equal(message.options.title, "");
  assert.equal(message.options.content, "");
  assert.ok(message.options.fields instanceof Map);
  assert.equal(message.options.fields.get(0x02), packed);
  // No appearance supplied -> no icon field.
  assert.equal(message.options.fields.has(0x04), false);

  Object.assign(deps, REAL_DEPS);
});

test("makeTelemetryDeliverer attaches the FIELD_ICON_APPEARANCE field alongside telemetry", async () => {
  const router = new FakeLxmRouter({}, {});
  const identity = { id: "me" };
  deps.LXMessage = FakeLXMessage;
  deps.FIELD_TELEMETRY = 0x02;
  deps.FIELD_ICON_APPEARANCE = 0x04;
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  const deliverTelemetry = makeTelemetryDeliverer(router, identity, {
    icon: "sail-boat",
    fg: [0, 0, 0],
    bg: [255, 255, 255],
  });
  const packed = new Uint8Array([1, 2, 3]);
  await deliverTelemetry("0123456789abcdef0123456789abcdef", packed);

  const { message } = router.sent[0];
  const fields = message.options.fields;
  // Telemetry is preserved.
  assert.equal(fields.get(0x02), packed);
  // Appearance rides along as [str, Uint8Array(3), Uint8Array(3)].
  const appearance = fields.get(0x04);
  assert.ok(appearance, "appearance field present");
  assert.equal(appearance[0], "sail-boat");
  assert.ok(appearance[1] instanceof Uint8Array);
  assert.ok(appearance[2] instanceof Uint8Array);
  assert.deepEqual(Array.from(appearance[1]), [0, 0, 0]);
  assert.deepEqual(Array.from(appearance[2]), [255, 255, 255]);

  Object.assign(deps, REAL_DEPS);
});

test("makeTelemetryDeliverer propagates delivery errors", async () => {
  const router = new FakeLxmRouter({}, {});
  router.send = async () => {
    throw new Error("identity unknown");
  };
  deps.LXMessage = FakeLXMessage;
  deps.FIELD_TELEMETRY = 0x02;
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  const deliverTelemetry = makeTelemetryDeliverer(router, {});
  await assert.rejects(
    () =>
      deliverTelemetry("0123456789abcdef0123456789abcdef", new Uint8Array([1])),
    /identity unknown/,
  );

  Object.assign(deps, REAL_DEPS);
});

test("makeDeliverer forwards the arrival link id so replies ride back over the established link", async () => {
  const router = new FakeLxmRouter({}, {});
  const identity = { id: "me" };
  deps.LXMessage = FakeLXMessage;
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  const deliver = makeDeliverer(router, identity);
  const linkId = new Uint8Array(8).fill(2);
  await deliver("0123456789abcdef0123456789abcdef", "", "Pong", linkId);

  assert.equal(router.sent.length, 1);
  assert.equal(
    router.sent[0].linkId,
    linkId,
    "link id passed through to lxmf.send",
  );

  // Without a link id (e.g. notification forwarding) it is left undefined so
  // the router falls back to opportunistic delivery.
  await deliver("0123456789abcdef0123456789abcdef", "", "Hi");
  assert.equal(router.sent[1].linkId, undefined);

  Object.assign(deps, REAL_DEPS);
});

test("makeDeliverer falls back to opportunistic delivery when the link reply fails", async () => {
  const router = new FakeLxmRouter({}, {});
  const identity = { id: "me" };
  deps.LXMessage = FakeLXMessage;
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  // Simulate a mobile client that tore the link down after its message was
  // acknowledged: the link send throws, so the reply must retry opportunistically.
  let firstAttempt = true;
  router.send = async (message, sentIdentity, linkId) => {
    if (firstAttempt && linkId) {
      firstAttempt = false;
      throw new Error("Link 7ef48b3f is not available");
    }
    router.sent.push({ message, identity: sentIdentity, linkId });
  };

  const deliver = makeDeliverer(router, identity);
  const linkId = new Uint8Array(8).fill(2);
  await deliver("0123456789abcdef0123456789abcdef", "", "Pong", linkId);

  assert.equal(
    router.sent.length,
    1,
    "the failed link send is not counted; one opportunistic retry went out",
  );
  assert.ok(!router.sent[0].linkId, "retry is opportunistic (no link id)");

  Object.assign(deps, REAL_DEPS);
});

test("makeDeliverer records delivery outcomes through the debug logger", async () => {
  const router = new FakeLxmRouter({}, {});
  const identity = { id: "me" };
  deps.LXMessage = FakeLXMessage;
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  const logs = [];
  const debug = (msg) => logs.push(msg);
  const deliver = makeDeliverer(router, identity, debug);
  const dest = "0123456789abcdef0123456789abcdef";

  // Success over a link.
  await deliver(dest, "", "Pong", new Uint8Array(8).fill(2));
  // Success opportunistic (no link).
  await deliver(dest, "", "Hi");
  // Link fails -> opportunistic fallback succeeds.
  let firstAttempt = true;
  router.send = async (message, sentIdentity, linkId) => {
    if (firstAttempt && linkId) {
      firstAttempt = false;
      throw new Error("Link is not available");
    }
    router.sent.push({ message, identity: sentIdentity, linkId });
  };
  await deliver(dest, "", "Pong", new Uint8Array(8).fill(3));

  assert.ok(
    logs.some((l) => /via the arrival link/.test(l)),
    "link delivery logged",
  );
  assert.ok(
    logs.some((l) => /\(opportunistic\)/.test(l)),
    "opportunistic delivery logged",
  );
  assert.ok(
    logs.some((l) => /link reply.*failed.*retrying opportunistic/.test(l)),
    "link failure before fallback logged",
  );
  assert.ok(
    logs.some((l) => /opportunistic fallback/.test(l)),
    "opportunistic fallback success logged",
  );

  Object.assign(deps, REAL_DEPS);
});

test("makeDeliverer propagates delivery errors", async () => {
  const router = new FakeLxmRouter({}, {});
  router.send = async () => {
    throw new Error("identity unknown");
  };
  deps.LXMessage = FakeLXMessage;
  deps.fromHex = (hex) => Buffer.from(hex, "hex");

  const deliver = makeDeliverer(router, {});
  await assert.rejects(
    () => deliver("0123456789abcdef0123456789abcdef", "t", "c"),
    /identity unknown/,
  );

  Object.assign(deps, REAL_DEPS);
});
