const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aspectNameHashHex,
  aspectNameHashesHex,
  discoverClosestNode,
  RFED_NODE_ASPECTS,
  PROPAGATION_ASPECT,
  DEFAULT_GRACE_MS,
} = require("../plugin/discovery");

/** Builds a transport announce event detail for the fakes below. */
function announceDetail({ nameHashHex, destinationHashHex, hops }) {
  const nameHash = Uint8Array.from(Buffer.from(nameHashHex, "hex"));
  const destinationHash = Uint8Array.from(
    Buffer.from(destinationHashHex, "hex"),
  );
  const detail = { destinationHash, nameHash };
  if (hops !== undefined) {
    detail.packet = { hops };
  }
  return { detail };
}

/** A minimal transport EventTarget stand-in (Node's EventTarget is enough). */
function makeTransport() {
  return new EventTarget();
}

// --- aspect name_hash helpers ----------------------------------------------

test("aspectNameHashHex matches @reticulum/core's aspectNameHash (SHA-256[:10])", async () => {
  const {
    aspectNameHash,
  } = require("@reticulum/core/src/transport/discovery.js");
  for (const aspect of [
    PROPAGATION_ASPECT,
    "rfed.delivery",
    "rfed.channel.subscribe",
    "lxmf.delivery",
  ]) {
    const lib = Buffer.from(await aspectNameHash(aspect)).toString("hex");
    assert.equal(aspectNameHashHex(aspect), lib, `match for ${aspect}`);
  }
});

test("aspectNameHashHex returns the first 10 bytes (20 hex chars), lowercase", () => {
  const hex = aspectNameHashHex(PROPAGATION_ASPECT);
  assert.equal(hex.length, 20);
  assert.equal(hex, hex.toLowerCase());
});

test("aspectNameHashesHex maps an array of aspects", () => {
  const hashes = aspectNameHashesHex(["a.b", "c.d"]);
  assert.deepEqual(hashes, [
    aspectNameHashHex("a.b"),
    aspectNameHashHex("c.d"),
  ]);
});

test("RFed discovery aspects exclude the client-only rfed.delivery", () => {
  assert.ok(!RFED_NODE_ASPECTS.includes("rfed.delivery"));
  // The federation-node entry points are all present.
  assert.ok(RFED_NODE_ASPECTS.includes("rfed.channel.subscribe"));
  assert.ok(RFED_NODE_ASPECTS.includes("rfed.channel.publish"));
});

// --- discoverClosestNode ----------------------------------------------------

test("discoverClosestNode returns a no-op unsubscribe when there is no transport", () => {
  const calls = [];
  const unsub = discoverClosestNode({
    rns: {},
    nameHashesHex: [aspectNameHashHex(PROPAGATION_ASPECT)],
    onSelect: (hex) => calls.push(hex),
  });
  assert.equal(typeof unsub, "function");
  assert.doesNotThrow(unsub);
  assert.deepEqual(calls, []);
});

test("discoverClosestNode returns a no-op unsubscribe for an empty name-hash set", () => {
  const unsub = discoverClosestNode({
    rns: { transport: makeTransport() },
    nameHashesHex: [],
    onSelect: () => {
      throw new Error("should not fire");
    },
  });
  assert.equal(typeof unsub, "function");
  assert.doesNotThrow(unsub);
});

test("discoverClosestNode selects the fewest-hops candidate after the grace window", async () => {
  const transport = makeTransport();
  const propAspect = aspectNameHashHex(PROPAGATION_ASPECT);
  const selected = [];
  const logs = [];
  const unsub = discoverClosestNode({
    rns: { transport },
    nameHashesHex: [propAspect],
    graceMs: 20,
    onSelect: (hex, hops) => selected.push({ hex, hops }),
    log: (...args) => logs.push(args.join(" ")),
  });

  // Two propagation nodes announce; the 1-hop one is closer.
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: propAspect,
        destinationHashHex: "11".repeat(16),
        hops: 3,
      }),
    ),
  );
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: propAspect,
        destinationHashHex: "22".repeat(16),
        hops: 1,
      }),
    ),
  );
  assert.deepEqual(selected, [], "no selection until the grace window elapses");

  // Wait past the grace window so the closest is locked in.
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(selected, [{ hex: "22".repeat(16), hops: 1 }]);

  // Selection is one-shot: a later announce does not re-fire onSelect.
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: propAspect,
        destinationHashHex: "33".repeat(16),
        hops: 0,
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(selected, [{ hex: "22".repeat(16), hops: 1 }]);
  unsub();
});

test("discoverClosestNode stops listening after selecting (unsubscribes itself)", async () => {
  const transport = makeTransport();
  const aspect = aspectNameHashHex(PROPAGATION_ASPECT);
  const selected = [];
  discoverClosestNode({
    rns: { transport },
    nameHashesHex: [aspect],
    graceMs: 0,
    onSelect: (hex) => selected.push(hex),
  });
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: aspect,
        destinationHashHex: "aa".repeat(16),
        hops: 2,
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(selected, ["aa".repeat(16)]);
  // After selection the listener is detached, so further announces are no-ops.
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: aspect,
        destinationHashHex: "bb".repeat(16),
        hops: 1,
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(selected, ["aa".repeat(16)]);
});

test("discoverClosestNode ignores announces whose aspect name_hash does not match", async () => {
  const transport = makeTransport();
  const aspect = aspectNameHashHex(PROPAGATION_ASPECT);
  const selected = [];
  discoverClosestNode({
    rns: { transport },
    nameHashesHex: [aspect],
    graceMs: 0,
    onSelect: (hex) => selected.push(hex),
  });
  // A different aspect (e.g. lxmf.delivery) must not match.
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: aspectNameHashHex("lxmf.delivery"),
        destinationHashHex: "cc".repeat(16),
        hops: 1,
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(selected, []);
});

test("discoverClosestNode treats a missing hop count as the least-preferred candidate", async () => {
  const transport = makeTransport();
  const aspect = aspectNameHashHex(PROPAGATION_ASPECT);
  const selected = [];
  discoverClosestNode({
    rns: { transport },
    nameHashesHex: [aspect],
    graceMs: 20,
    onSelect: (hex, hops) => selected.push({ hex, hops }),
  });
  // First candidate has no hops -> Infinity; a 2-hop one later is closer.
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: aspect,
        destinationHashHex: "dd".repeat(16),
      }),
    ),
  );
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: aspect,
        destinationHashHex: "ee".repeat(16),
        hops: 2,
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(selected, [{ hex: "ee".repeat(16), hops: 2 }]);
});

test("discoverClosestNode never fires onSelect when no matching announce is heard", async () => {
  const transport = makeTransport();
  const aspect = aspectNameHashHex(PROPAGATION_ASPECT);
  const selected = [];
  discoverClosestNode({
    rns: { transport },
    nameHashesHex: [aspect],
    graceMs: 10,
    onSelect: (hex) => selected.push(hex),
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(selected, []);
});

test("discoverClosestNode unsubscribe detaches the listener and never fires onSelect", () => {
  const transport = makeTransport();
  const aspect = aspectNameHashHex(PROPAGATION_ASPECT);
  const selected = [];
  const unsub = discoverClosestNode({
    rns: { transport },
    nameHashesHex: [aspect],
    graceMs: 100,
    onSelect: (hex) => selected.push(hex),
  });
  unsub();
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: aspect,
        destinationHashHex: "ff".repeat(16),
        hops: 1,
      }),
    ),
  );
  assert.deepEqual(selected, []);
});

test("discoverClosestNode can match any aspect in a set (rfed server aspects)", async () => {
  const transport = makeTransport();
  const hashes = aspectNameHashesHex(RFED_NODE_ASPECTS);
  const selected = [];
  discoverClosestNode({
    rns: { transport },
    nameHashesHex: hashes,
    graceMs: 0,
    onSelect: (hex) => selected.push(hex),
  });
  // An announce on rfed.channel.publish (a server aspect) matches.
  transport.dispatchEvent(
    new CustomEvent(
      "announce",
      announceDetail({
        nameHashHex: aspectNameHashHex("rfed.channel.publish"),
        destinationHashHex: "ab".repeat(16),
        hops: 1,
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(selected, ["ab".repeat(16)]);
});

test("DEFAULT_GRACE_MS is a positive number", () => {
  assert.equal(typeof DEFAULT_GRACE_MS, "number");
  assert.ok(DEFAULT_GRACE_MS > 0);
});
