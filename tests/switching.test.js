const test = require("node:test");
const assert = require("node:assert/strict");

const switching = require("../plugin/commands/switching");
const { commands } = require("../plugin/commands");

const SOURCE = new Uint8Array(16).fill(5);
const SOURCE_HEX = Buffer.from(SOURCE).toString("hex");

/** A minimal message shape for the command tests. */
function makeMessage(content, sourceHash = SOURCE) {
  return { content, sourceHash };
}

/** A recording deliver callback:
 * `deliver(destHash, title, content, linkId?)`. */
function makeDeliver() {
  const calls = [];
  const deliver = async (destHash, title, content, linkId) => {
    calls.push({ destHash, title, content, linkId });
  };
  return { deliver, calls };
}

/** An app stub whose `putSelfPath` completes immediately with 200 OK. */
function makeApp() {
  const puts = [];
  const app = {
    putSelfPath(path, value, cb) {
      puts.push({ path, value });
      setImmediate(cb, { state: "COMPLETED", statusCode: 200 });
    },
  };
  return { app, puts };
}

/** An app stub whose `putSelfPath` completes with a non-200 failure. */
function makeFailingApp(statusCode = 404, message = "No such switch") {
  const puts = [];
  const app = {
    putSelfPath(path, value, cb) {
      puts.push({ path, value });
      setImmediate(cb, { state: "COMPLETED", statusCode, message });
    },
  };
  return { app, puts };
}

const ENABLED = { messaging: { digital_switching: true } };

test("the switching command is registered", () => {
  assert.equal(commands.switching, switching);
});

test("switching is crew-only", () => {
  assert.equal(switching.crewOnly, true);
});

test("switching accepts 'turn decklight on' when enabled", () => {
  assert.equal(
    switching.accept(makeMessage("turn decklight on"), ENABLED),
    true,
  );
});

test("switching accepts nested switch paths like Cerbo GX relays", () => {
  assert.equal(
    switching.accept(makeMessage("turn gx.gxInternalRelay1 on"), ENABLED),
    true,
  );
  assert.equal(
    switching.accept(makeMessage("Turn gx.gxInternalRelay2 Off"), ENABLED),
    true,
  );
});

test("switching accepts 'Turn Decklight Off' (case-insensitive)", () => {
  assert.equal(
    switching.accept(makeMessage("Turn Decklight Off"), ENABLED),
    true,
  );
});

test("switching accepts content with surrounding whitespace", () => {
  assert.equal(
    switching.accept(makeMessage("  turn bilge on  "), ENABLED),
    true,
  );
});

test("switching matches when the trigger is embedded in a longer message", () => {
  // The regex is not anchored, so a match anywhere in the content is accepted,
  // matching the signalk-meshtastic behaviour.
  assert.equal(
    switching.accept(makeMessage("hey, turn decklight off please"), ENABLED),
    true,
  );
});

test("switching does not accept messages without the trigger phrase", () => {
  assert.equal(switching.accept(makeMessage("hello"), ENABLED), false);
  assert.equal(switching.accept(makeMessage("turn on"), ENABLED), false);
  assert.equal(switching.accept(makeMessage(""), ENABLED), false);
});

test("switching rejects when digital_switching is disabled", () => {
  assert.equal(
    switching.accept(makeMessage("turn decklight on"), {
      messaging: { digital_switching: false },
    }),
    false,
  );
});

test("switching rejects when no messaging settings are configured", () => {
  assert.equal(switching.accept(makeMessage("turn decklight on"), {}), false);
  assert.equal(
    switching.accept(makeMessage("turn decklight on"), undefined),
    false,
  );
});

test("switching rejects messages without content", () => {
  assert.equal(switching.accept({ content: undefined }, ENABLED), false);
  assert.equal(switching.accept(null, ENABLED), false);
});

test("handle writes the switch state via putSelfPath and replies OK", async () => {
  const { deliver, calls } = makeDeliver();
  const { app, puts } = makeApp();

  await switching.handle(
    makeMessage("turn decklight on"),
    ENABLED,
    deliver,
    app,
  );

  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, "electrical.switches.decklight.state");
  assert.equal(puts[0].value, true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].destHash, SOURCE_HEX);
  assert.equal(calls[0].content, "OK, decklight is on");
});

test("handle sets the state to false for 'off'", async () => {
  const { deliver, calls } = makeDeliver();
  const { app, puts } = makeApp();

  await switching.handle(
    makeMessage("Turn Decklight Off"),
    ENABLED,
    deliver,
    app,
  );

  assert.equal(puts[0].value, false);
  // The switch name is echoed in its original casing; the on/off word is
  // normalised to lowercase.
  assert.equal(calls[0].content, "OK, Decklight is off");
});

test("handle switches a Cerbo GX relay off and replies with the full path", async () => {
  const { deliver, calls } = makeDeliver();
  const { app, puts } = makeApp();

  await switching.handle(
    makeMessage("turn gx.gxInternalRelay2 off"),
    ENABLED,
    deliver,
    app,
  );

  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, "electrical.switches.gx.gxInternalRelay2.state");
  assert.equal(puts[0].value, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, "OK, gx.gxInternalRelay2 is off");
});

test("handle forwards the arrival link id on the reply", async () => {
  const { deliver, calls } = makeDeliver();
  const { app } = makeApp();
  const linkId = new Uint8Array(8).fill(7);

  await switching.handle(
    makeMessage("turn decklight on"),
    ENABLED,
    deliver,
    app,
    linkId,
  );

  assert.equal(calls[0].linkId, linkId);
});

test("handle reports a failed put back to the crew and re-throws", async () => {
  const { deliver, calls } = makeDeliver();
  const { app } = makeFailingApp(404, "No such switch");

  await assert.rejects(
    switching.handle(makeMessage("turn decklight on"), ENABLED, deliver, app),
    /No such switch/,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].destHash, SOURCE_HEX);
  assert.match(calls[0].content, /could not switch decklight/i);
  assert.match(calls[0].content, /No such switch/);
});

test("handle reports an error when the put API is unavailable", async () => {
  const { deliver, calls } = makeDeliver();

  await assert.rejects(
    switching.handle(makeMessage("turn decklight on"), ENABLED, deliver, {}),
    /Signal K put API unavailable/,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].content, /could not switch decklight/i);
});
