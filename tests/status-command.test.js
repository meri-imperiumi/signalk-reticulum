const test = require("node:test");
const assert = require("node:assert/strict");

const { commands } = require("../plugin/commands");
const status = require("../plugin/commands/status");

const SOURCE = new Uint8Array(16).fill(5);
const SOURCE_HEX = Buffer.from(SOURCE).toString("hex");

/** A minimal message shape for the command tests. */
function makeMessage(content, sourceHash = SOURCE) {
  return { content, sourceHash };
}

/** A recording deliver callback: `deliver(destHash, title, content, linkId?)`. */
function makeDeliver() {
  const calls = [];
  const deliver = async (destHash, title, content, linkId) => {
    calls.push({ destHash, title, content, linkId });
  };
  return { deliver, calls };
}

/** An app fake answering getSelfPath with raw `{value}` wrappers. */
function makeApp(paths) {
  return {
    getSelfPath: (path) => paths[path],
  };
}

test("the status command is registered", () => {
  assert.equal(commands.status, status);
});

test("status is available to everyone (not crew-only)", () => {
  assert.equal(status.crewOnly, false);
});

test("status accepts a lowercase 'status' content", () => {
  assert.equal(status.accept(makeMessage("status")), true);
});

test("status accepts 'Status' with surrounding whitespace", () => {
  assert.equal(status.accept(makeMessage("  Status ")), true);
});

test("status does not accept other content", () => {
  assert.equal(status.accept(makeMessage("hello")), false);
  assert.equal(status.accept(makeMessage("")), false);
  assert.equal(status.accept({ content: undefined }), false);
  assert.equal(status.accept(null), false);
});

test("status replies with the same lines the NomadNet page renders", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp({
    "navigation.state": { value: "anchored" },
    "navigation.position": {
      value: { latitude: 60.1234, longitude: 21.5678 },
    },
    "environment.depth.belowSurface": { value: 5.24 },
    "environment.wind.speedOverGround": { value: 6 },
    "environment.wind.directionTrue": { value: Math.PI / 4 },
    "electrical.batteries.house.capacity.stateOfCharge": { value: 0.873 },
    "electrical.batteries.house.current": { value: 2.3 },
  });
  await status.handle(makeMessage("status"), {}, deliver, app);
  assert.equal(calls.length, 1, "one reply message");
  // The vessel name is not repeated: the sender already sees it as the
  // destination's announced display name
  assert.equal(
    calls[0].content,
    [
      "Vessel is anchored",
      "**Position:** 60\u00B007.404' N, 021\u00B034.068' E",
      "**Depth:** 5.2 m below surface",
      "**Wind:** 12 kn from 45\u00B0",
      "**Battery:** 87 %, 2.3 A",
    ].join("\n"),
  );
  assert.equal(calls[0].title, "");
});

test("status sends the whole report as a single message", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp({
    "navigation.state": { value: "sailing" },
    "navigation.position": {
      value: { latitude: -60.1234, longitude: -21.5678 },
    },
    "navigation.anchor.distanceFromBow": { value: 12.56 },
    "environment.depth.belowSurface": { value: 5.24 },
    "environment.tide.heightNow": { value: 1.3 },
    "environment.tide.state": "rising",
    "environment.wind.speedOverGround": { value: 6 },
    "environment.wind.directionTrue": { value: Math.PI / 4 },
    "electrical.batteries.house.capacity.stateOfCharge": { value: 0.873 },
    "electrical.batteries.house.current": { value: 2.3 },
  });
  await status.handle(makeMessage("status"), {}, deliver, app);
  // LXMF carries long payloads, so unlike the Meshtastic command there is no
  // packet-size splitting: one message, no matter how full the report
  assert.equal(calls.length, 1);
});

test("status omits readings the server does not report", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp({
    "environment.depth.belowSurface": { value: 5.24 },
  });
  await status.handle(makeMessage("status"), {}, deliver, app);
  assert.equal(calls[0].content, "**Depth:** 5.2 m below surface");
});

test("status tells the sender when no readings are available", async () => {
  const { deliver, calls } = makeDeliver();
  await status.handle(makeMessage("status"), {}, deliver, makeApp({}));
  assert.equal(calls[0].content, "No telemetry available");
});

test("status tolerates an app without getSelfPath", async () => {
  const { deliver, calls } = makeDeliver();
  await status.handle(makeMessage("status"), {}, deliver, {});
  assert.equal(calls[0].content, "No telemetry available");
});

test("status replies to the sender's source hash and forwards the link id", async () => {
  const { deliver, calls } = makeDeliver();
  const linkId = new Uint8Array(8).fill(3);
  await status.handle(makeMessage("status"), {}, deliver, makeApp({}), linkId);
  assert.equal(calls[0].destHash, SOURCE_HEX);
  assert.equal(calls[0].linkId, linkId, "link id threaded into deliver");
});

test("status appends the energy predictor outlook to the battery line", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp({
    "electrical.batteries.house.capacity.stateOfCharge": { value: 0.873 },
    "electrical.energy.prediction.status": { value: "surplus" },
  });
  await status.handle(makeMessage("status"), {}, deliver, app);
  assert.equal(calls[0].content, "**Battery:** 87 %, surplus");
});

test("status reports the plain battery line without the energy predictor", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp({
    "electrical.batteries.house.capacity.stateOfCharge": { value: 0.873 },
  });
  await status.handle(makeMessage("status"), {}, deliver, app);
  assert.equal(calls[0].content, "**Battery:** 87 %");
});

test("status summarizes the status tiles when the plugin publishes them", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp({
    // What getSelfPath returns for an intermediate path: the subtree of leaf
    // nodes below it
    "statusTiles.tiles": {
      housebank: { value: "red" },
      bilge: { value: "amber" },
      watermaker: { value: "opportunity" },
      anchor: { value: "neutral" },
      fridge: { value: "green" },
    },
  });
  await status.handle(makeMessage("status"), {}, deliver, app);
  assert.equal(calls[0].content, "**Systems:** red housebank; amber bilge");
});

test("status reports all systems green when every tile is green", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp({
    "statusTiles.tiles": {
      housebank: { value: "green" },
      bilge: { value: "green" },
    },
  });
  await status.handle(makeMessage("status"), {}, deliver, app);
  assert.equal(calls[0].content, "**Systems:** all green");
});

test("status stays quiet about systems on a boat without status tiles", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp({
    "environment.depth.belowSurface": { value: 5.24 },
  });
  await status.handle(makeMessage("status"), {}, deliver, app);
  assert.equal(calls[0].content, "**Depth:** 5.2 m below surface");
});
