const test = require("node:test");
const assert = require("node:assert/strict");

const { triggerAnnounce } = require("../plugin/announce");
const makePlugin = require("../plugin/index.js");

/**
 * Smoketests for {@link triggerAnnounce}: the immediate, manual re-announce of
 * every active destination used by the connectivity-change trigger.
 *
 * The handles are plain recording stubs (no RNS stack), since triggerAnnounce
 * only depends on the `announce` methods the LXMF router and the NomadNet node
 * destination expose.
 */

/** A recording LXMF-router stub mirroring FakeLxmRouter.announce. */
function makeLxmf(name) {
  return {
    announceCalls: [],
    async announce(displayName) {
      this.announceCalls.push(displayName);
    },
    displayName: name,
  };
}

/** A recording NomadNet-site stub (the shape setupNomadNet returns). */
function makeNomadnet() {
  return {
    destination: {
      announceCalls: 0,
      async announce() {
        this.announceCalls += 1;
      },
    },
  };
}

test("triggerAnnounce re-announces both the LXMF and NomadNet destinations", async () => {
  const lxmf = makeLxmf("My Boat");
  const nomadnet = makeNomadnet();
  const logs = [];

  const n = await triggerAnnounce(
    { lxmf, displayName: "My Boat", nomadnet },
    (msg) => logs.push(msg),
  );

  assert.equal(n, 2, "both destinations announced");
  assert.deepEqual(lxmf.announceCalls, ["My Boat"]);
  assert.equal(nomadnet.destination.announceCalls, 1);
  assert.equal(logs.length, 2);
});

test("triggerAnnounce skips NomadNet when no site is configured", async () => {
  const lxmf = makeLxmf("My Boat");

  const n = await triggerAnnounce({ lxmf, displayName: "My Boat" }, () => {});

  assert.equal(n, 1, "only LXMF announced");
  assert.deepEqual(lxmf.announceCalls, ["My Boat"]);
});

test("triggerAnnounce skips LXMF when there is no display name", async () => {
  const nomadnet = makeNomadnet();

  const n = await triggerAnnounce(
    { lxmf: makeLxmf("My Boat"), displayName: "", nomadnet },
    () => {},
  );

  assert.equal(n, 1, "only NomadNet announced (LXMF has no name)");
  assert.equal(nomadnet.destination.announceCalls, 1);
});

test("triggerAnnounce announces nothing when neither destination is up", async () => {
  const n = await triggerAnnounce({}, () => {});
  assert.equal(n, 0);
});

test("triggerAnnounce continues to the next destination when one fails", async () => {
  const lxmf = {
    async announce() {
      throw new Error("lxmf boom");
    },
  };
  const nomadnet = makeNomadnet();
  const logs = [];

  const n = await triggerAnnounce(
    { lxmf, displayName: "My Boat", nomadnet },
    (msg) => logs.push(msg),
  );

  // The LXMF failure was logged but did not abort the NomadNet announce.
  assert.equal(n, 1, "NomadNet still announced after LXMF failure");
  assert.equal(nomadnet.destination.announceCalls, 1);
  assert.ok(
    logs.some((l) => /Failed to re-announce lxmf\.delivery/.test(l)),
    "LXMF failure was logged",
  );
});

test("triggerAnnounce tolerates a NomadNet destination without an announce method", async () => {
  const lxmf = makeLxmf("My Boat");
  // e.g. a malformed site handle; should be skipped, not throw.
  const nomadnet = { destination: {} };

  const n = await triggerAnnounce(
    { lxmf, displayName: "My Boat", nomadnet },
    () => {},
  );

  assert.equal(n, 1, "only LXMF announced");
  assert.deepEqual(lxmf.announceCalls, ["My Boat"]);
});

test("triggerAnnounce re-announces the external rfed.delivery destination", async () => {
  const rfed = {
    deliveryDest: {
      announceCalls: 0,
      async announce() {
        this.announceCalls += 1;
      },
    },
  };
  const logs = [];

  const n = await triggerAnnounce({ rfed }, (msg) => logs.push(msg));

  assert.equal(n, 1, "rfed.delivery announced");
  assert.equal(rfed.deliveryDest.announceCalls, 1);
  assert.ok(
    logs.some((l) => /Re-announced rfed\.delivery/.test(l)),
    "rfed.delivery re-announce logged",
  );
});

test("triggerAnnounce re-announces the embedded rfed federation node", async () => {
  const embeddedRfed = {
    announceCalls: 0,
    async announce() {
      this.announceCalls += 1;
    },
  };
  const logs = [];

  const n = await triggerAnnounce({ embeddedRfed }, (msg) => logs.push(msg));

  assert.equal(n, 1, "embedded rfed node announced");
  assert.equal(embeddedRfed.announceCalls, 1);
  assert.ok(
    logs.some((l) => /Re-announced embedded rfed federation node/.test(l)),
    "embedded rfed re-announce logged",
  );
});

test("triggerAnnounce re-announces the embedded lxmf.propagation destination", async () => {
  const propagationLxmf = {
    announceCalls: 0,
    async announcePropagationNode() {
      this.announceCalls += 1;
    },
  };
  const logs = [];

  const n = await triggerAnnounce({ propagationLxmf }, (msg) => logs.push(msg));

  assert.equal(n, 1, "lxmf.propagation announced");
  assert.equal(propagationLxmf.announceCalls, 1);
  assert.ok(
    logs.some((l) => /Re-announced lxmf\.propagation/.test(l)),
    "lxmf.propagation re-announce logged",
  );
});

test("triggerAnnounce re-announces every destination at once on a connectivity change", async () => {
  const lxmf = makeLxmf("My Boat");
  const nomadnet = makeNomadnet();
  const rfed = {
    deliveryDest: {
      announceCalls: 0,
      async announce() {
        this.announceCalls += 1;
      },
    },
  };
  const embeddedRfed = {
    announceCalls: 0,
    async announce() {
      this.announceCalls += 1;
    },
  };
  const propagationLxmf = {
    announceCalls: 0,
    async announcePropagationNode() {
      this.announceCalls += 1;
    },
  };

  const n = await triggerAnnounce(
    {
      lxmf,
      displayName: "My Boat",
      nomadnet,
      rfed,
      embeddedRfed,
      propagationLxmf,
    },
    () => {},
  );

  assert.equal(n, 5, "all five destinations announced");
  assert.deepEqual(lxmf.announceCalls, ["My Boat"]);
  assert.equal(nomadnet.destination.announceCalls, 1);
  assert.equal(rfed.deliveryDest.announceCalls, 1);
  assert.equal(embeddedRfed.announceCalls, 1);
  assert.equal(propagationLxmf.announceCalls, 1);
});

test("triggerAnnounce tolerates an rfed client without a deliveryDest", async () => {
  const lxmf = makeLxmf("My Boat");
  const n = await triggerAnnounce(
    { lxmf, displayName: "My Boat", rfed: {} },
    () => {},
  );
  assert.equal(n, 1, "only LXMF announced (rfed skipped)");
});

test("triggerAnnounce continues when the embedded rfed node announce fails", async () => {
  const lxmf = makeLxmf("My Boat");
  const embeddedRfed = {
    async announce() {
      throw new Error("rfed boom");
    },
  };
  const logs = [];

  const n = await triggerAnnounce(
    { lxmf, displayName: "My Boat", embeddedRfed },
    (msg) => logs.push(msg),
  );

  assert.equal(n, 1, "LXMF still announced after rfed failure");
  assert.deepEqual(lxmf.announceCalls, ["My Boat"]);
  assert.ok(
    logs.some((l) => /Failed to re-announce embedded rfed node/.test(l)),
    "rfed failure logged",
  );
});

// --- connectivity path/value helpers --------------------------------------

test("effectiveConnectivityPaths defaults to Starlink and LTE when unset", () => {
  const expected = [
    "network.providers.starlink.status",
    "networking.lte.registerNetworkDisplay",
  ];
  assert.deepEqual(makePlugin.effectiveConnectivityPaths(undefined), expected);
  assert.deepEqual(makePlugin.effectiveConnectivityPaths(null), expected);
  assert.deepEqual(
    makePlugin.effectiveConnectivityPaths("not-an-array"),
    expected,
  );
});

test("effectiveConnectivityPaths honours an explicit empty list as disabled", () => {
  assert.deepEqual(makePlugin.effectiveConnectivityPaths([]), []);
});

test("effectiveConnectivityPaths trims, drops blanks and de-dupes", () => {
  assert.deepEqual(
    makePlugin.effectiveConnectivityPaths([
      "network.providers.starlink.status ",
      "  ",
      "networking.lte.registerNetworkDisplay",
      "network.providers.starlink.status",
      123,
    ]),
    [
      "network.providers.starlink.status",
      "networking.lte.registerNetworkDisplay",
    ],
  );
});

test("normalizeConnectivityValue unwraps {value} deltas and stringifies", () => {
  assert.equal(makePlugin.normalizeConnectivityValue("online"), '"online"');
  assert.equal(
    makePlugin.normalizeConnectivityValue({ value: "online" }),
    '"online"',
  );
  assert.equal(makePlugin.normalizeConnectivityValue(undefined), undefined);
  assert.equal(makePlugin.normalizeConnectivityValue(null), undefined);
  // Distinct objects compare equal only when their JSON is equal.
  assert.notEqual(
    makePlugin.normalizeConnectivityValue("online"),
    makePlugin.normalizeConnectivityValue("offline"),
  );
});

test("the default connectivity paths are Starlink and LTE", () => {
  assert.deepEqual(makePlugin.DEFAULT_CONNECTIVITY_PATHS, [
    "network.providers.starlink.status",
    "networking.lte.registerNetworkDisplay",
  ]);
});
