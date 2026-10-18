const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INTERNET_STATE_PATH,
  METERED_STATE,
  METERED_GRACE_MS,
  normalizeInternetState,
  isMeteredState,
  normalizeHashList,
  effectiveKnownHashes,
  trafficPolicy,
  makeThrottledIngestFilter,
  applyMeteredPolicy,
  createMeteredTracker,
} = require("../plugin/traffic");
const { deriveLxmfDestinationHash } = require("../plugin/identity");

const OWN_HASH = "a".repeat(32);
const CREW_ID = "b".repeat(32);
const CREW_DEST = deriveLxmfDestinationHash(CREW_ID);
const CREW_LEGACY_DEST = "c".repeat(32);
const EXTRA_HASH = "d".repeat(32);
const STRANGER = "e".repeat(32);
const OWN_DEST = deriveLxmfDestinationHash(OWN_HASH);

// --- normalizeInternetState -------------------------------------------------

test("normalizeInternetState unwraps {value} wrappers and lowercases", () => {
  assert.equal(normalizeInternetState("metered"), "metered");
  assert.equal(normalizeInternetState({ value: "METERED" }), "metered");
  assert.equal(normalizeInternetState({ value: " Online " }), "online");
  assert.equal(normalizeInternetState(""), null);
  assert.equal(normalizeInternetState(null), null);
  assert.equal(normalizeInternetState(undefined), null);
  assert.equal(normalizeInternetState({ value: 42 }), null);
});

// --- isMeteredState ---------------------------------------------------------

test("isMeteredState is true only for metered", () => {
  assert.equal(isMeteredState("metered"), true);
  assert.equal(isMeteredState("online"), false);
  assert.equal(isMeteredState("offline"), false);
  assert.equal(isMeteredState("captive"), false);
  assert.equal(isMeteredState(null), false);
  assert.equal(isMeteredState(undefined), false);
  assert.equal(INTERNET_STATE_PATH, "network.internet.state");
  assert.equal(METERED_STATE, "metered");
});

// --- normalizeHashList ------------------------------------------------------

test("normalizeHashList validates, lowercases and dedupes hashes", () => {
  const raw = [
    EXTRA_HASH.toUpperCase(),
    ` ${"0".repeat(32)} `,
    EXTRA_HASH,
    "nothex",
    null,
    42,
    "1234",
  ];
  assert.deepEqual(normalizeHashList(raw), [EXTRA_HASH, "0".repeat(32)]);
});

test("normalizeHashList tolerates non-array input", () => {
  assert.deepEqual(normalizeHashList(undefined), []);
  assert.deepEqual(normalizeHashList(null), []);
  assert.deepEqual(normalizeHashList("abc"), []);
});

// --- effectiveKnownHashes ---------------------------------------------------

test("effectiveKnownHashes lists lxmf.delivery destination hashes only", () => {
  const config = {
    crew: [
      { name: "Skipper", identity: CREW_ID },
      // Legacy destination-only entry: matched by its raw destination hash.
      { name: "Legacy", destination: CREW_LEGACY_DEST },
    ],
    traffic_limits: { known_nodes: [EXTRA_HASH.toUpperCase(), EXTRA_HASH] },
  };
  const hashes = effectiveKnownHashes(config, OWN_HASH);
  assert.deepEqual(
    hashes.sort(),
    [OWN_DEST, CREW_DEST, CREW_LEGACY_DEST, EXTRA_HASH].sort(),
  );
  // Raw identity hashes are NOT delivery destinations — the mirrored-blob
  // filter matches recipients only.
  assert.ok(!hashes.includes(OWN_HASH));
  assert.ok(!hashes.includes(CREW_ID));
  // No duplicates between overlapping sources.
  assert.equal(hashes.length, new Set(hashes).size);
});

test("effectiveKnownHashes works with no config and no own hash", () => {
  assert.deepEqual(effectiveKnownHashes(undefined, undefined), []);
});

// --- trafficPolicy ----------------------------------------------------------

test("trafficPolicy throttles by default when metered", () => {
  const policy = trafficPolicy(
    { crew: [{ identity: CREW_ID }] },
    true,
    OWN_HASH,
  );
  assert.equal(policy.metered, true);
  assert.equal(policy.throttleThirdParty, true);
  assert.ok(policy.knownHashes.includes(OWN_DEST));
  assert.ok(policy.knownHashes.includes(CREW_DEST));
});

test("trafficPolicy does not throttle when unmetered or setting disabled", () => {
  assert.equal(
    trafficPolicy(undefined, false, OWN_HASH).throttleThirdParty,
    false,
  );
  const off = trafficPolicy(
    { traffic_limits: { throttle_third_party_metered: false } },
    true,
    OWN_HASH,
  );
  assert.equal(off.throttleThirdParty, false);
  // The known list is still resolved (cheap) but unused while not throttling.
  assert.ok(off.knownHashes.includes(OWN_DEST));
});

// --- makeThrottledIngestFilter ------------------------------------------------

test("throttled ingestFilter drops mirrored traffic not addressed to the boat", () => {
  const filter = makeThrottledIngestFilter(
    effectiveKnownHashes({ crew: [{ identity: CREW_ID }] }, OWN_HASH),
  );
  const toBoat = { destinationHash: Buffer.from(OWN_DEST, "hex") };
  const toCrew = { destinationHash: Buffer.from(CREW_DEST, "hex") };
  const toStranger = { destinationHash: Buffer.from(STRANGER, "hex") };
  assert.equal(filter(toBoat), true, "own delivery kept");
  assert.equal(filter(toCrew), true, "crew delivery kept");
  assert.equal(filter(toStranger), false, "3rd-party mirrored traffic dropped");
  assert.equal(filter({}), false);
  assert.equal(filter(null), false);
});

// --- applyMeteredPolicy ------------------------------------------------------

function fakeLxmf() {
  return {
    propagationNode: {
      ingestFilter: null,
    },
  };
}

test("applyMeteredPolicy arms the mirrored-traffic filter when throttled", () => {
  const lxmf = fakeLxmf();
  const logs = [];
  applyMeteredPolicy({
    lxmf,
    policy: trafficPolicy(
      { crew: [{ name: "Skipper", identity: CREW_ID }] },
      true,
      OWN_HASH,
    ),
    log: (msg) => logs.push(msg),
  });
  const ingestFilter = lxmf.propagationNode.ingestFilter;
  assert.equal(
    ingestFilter({ destinationHash: Buffer.from(CREW_DEST, "hex") }),
    true,
  );
  assert.equal(
    ingestFilter({ destinationHash: Buffer.from(STRANGER, "hex") }),
    false,
  );
  // The identityAllowed gate is deliberately left open (crew-addressed
  // messages must keep flowing in from peers; see work doc #47).
  assert.equal(lxmf.propagationNode.identityAllowed, undefined);
  assert.ok(logs.some((l) => l.includes("Metered internet")));
});

test("applyMeteredPolicy removes the filter when unthrottled", () => {
  const lxmf = fakeLxmf();
  lxmf.propagationNode.ingestFilter = () => true;
  applyMeteredPolicy({
    lxmf,
    policy: trafficPolicy(undefined, false, OWN_HASH),
    log: () => {},
  });
  assert.equal(
    lxmf.propagationNode.ingestFilter,
    null,
    "ingest filter removed",
  );
});

test("applyMeteredPolicy tolerates missing nodes and logs the RFed gap", () => {
  const logs = [];
  applyMeteredPolicy({
    lxmf: {},
    rfed: {},
    policy: trafficPolicy(undefined, true, OWN_HASH),
    log: (msg) => logs.push(msg),
  });
  applyMeteredPolicy({ policy: null, log: (msg) => logs.push(msg) });
  assert.ok(
    logs.some((l) => l.includes("@reticulum/rfed")),
    "notes the missing RFed lever",
  );
});

// --- createMeteredTracker ----------------------------------------------------

test("createMeteredTracker initialises without firing", async () => {
  let fired = 0;
  const tracker = createMeteredTracker({
    graceMs: 10,
    onChange: () => fired++,
  });
  tracker.observe("metered");
  assert.equal(tracker.metered, true);
  assert.equal(tracker.state, "metered");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, 0, "no synthetic flip at initialisation");
});

test("createMeteredTracker commits a flip after the grace window", async () => {
  let fired = 0;
  let last;
  const tracker = createMeteredTracker({
    graceMs: 10,
    onChange: (metered) => {
      fired++;
      last = metered;
    },
  });
  tracker.observe("metered");
  tracker.observe("online");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fired, 0, "not yet out of the grace window");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, 1);
  assert.equal(last, false);
});

test("createMeteredTracker cancels a pending flip that reverses within grace", async () => {
  let fired = 0;
  const tracker = createMeteredTracker({
    graceMs: 20,
    onChange: () => fired++,
  });
  tracker.observe("online");
  tracker.observe("metered");
  tracker.observe("offline");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 0, "flapping never commits");
  assert.equal(tracker.metered, false);
});

test("createMeteredTracker debounces a same-direction flapping sequence", async () => {
  let fired = 0;
  const tracker = createMeteredTracker({
    graceMs: 20,
    onChange: () => fired++,
  });
  tracker.observe("online");
  tracker.observe("metered");
  // Re-observe the same value mid-grace: must not restart or double-fire.
  tracker.observe("metered");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, 1);
  assert.equal(tracker.metered, true);
});

test("createMeteredTracker commits an unmetered flip after a committed metered one", async () => {
  const fired = [];
  const tracker = createMeteredTracker({
    graceMs: 10,
    onChange: (metered) => fired.push(metered),
  });
  tracker.observe("online");
  tracker.observe("metered");
  await new Promise((r) => setTimeout(r, 30));
  tracker.observe("online");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fired, [true, false]);
});

test("createMeteredTracker dispose cancels a pending transition", async () => {
  let fired = 0;
  const tracker = createMeteredTracker({
    graceMs: 20,
    onChange: () => fired++,
  });
  tracker.observe("online");
  tracker.observe("metered");
  tracker.dispose();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 0, "pending flip cancelled on dispose");
  assert.equal(tracker.metered, false, "committed state unchanged");
  // A disposed tracker still observes (re-arming works after teardown).
  tracker.observe("online");
  tracker.observe("metered");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, 1);
});

test("createMeteredTracker uses the default grace constant", () => {
  const tracker = createMeteredTracker({ onChange: () => {} });
  tracker.observe("online");
  tracker.observe("metered");
  assert.equal(tracker.state, "metered");
  assert.equal(METERED_GRACE_MS > 0, true);
});
