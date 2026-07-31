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

// --- connectivity path/value helpers --------------------------------------

test("effectiveConnectivityPaths defaults to the Starlink path when unset", () => {
  assert.deepEqual(makePlugin.effectiveConnectivityPaths(undefined), [
    "network.providers.starlink.status",
  ]);
  assert.deepEqual(makePlugin.effectiveConnectivityPaths(null), [
    "network.providers.starlink.status",
  ]);
  assert.deepEqual(makePlugin.effectiveConnectivityPaths("not-an-array"), [
    "network.providers.starlink.status",
  ]);
});

test("effectiveConnectivityPaths honours an explicit empty list as disabled", () => {
  assert.deepEqual(makePlugin.effectiveConnectivityPaths([]), []);
});

test("effectiveConnectivityPaths trims, drops blanks and de-dupes", () => {
  assert.deepEqual(
    makePlugin.effectiveConnectivityPaths([
      "network.providers.starlink.status ",
      "  ",
      "network.providers.lte.status",
      "network.providers.starlink.status",
      123,
    ]),
    ["network.providers.starlink.status", "network.providers.lte.status"],
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

test("the default connectivity path is the Starlink provider status", () => {
  assert.equal(
    makePlugin.DEFAULT_CONNECTIVITY_PATH,
    "network.providers.starlink.status",
  );
});
