const test = require("node:test");
const assert = require("node:assert/strict");

const { commands, isFromCrew, handleMessage } = require("../plugin/commands");
const ping = require("../plugin/commands/ping");
const { fromHex } = require("@reticulum/core");
const { deriveLxmfDestinationHash } = require("../plugin/identity");

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

test("the ping command is registered", () => {
  assert.equal(commands.ping, ping);
});

test("ping is available to everyone (not crew-only)", () => {
  assert.equal(ping.crewOnly, false);
});

test("ping accepts a lowercase 'ping' content", () => {
  assert.equal(ping.accept(makeMessage("ping")), true);
});

test("ping accepts 'Ping' with surrounding whitespace", () => {
  assert.equal(ping.accept(makeMessage("  Ping ")), true);
});

test("ping does not accept other content", () => {
  assert.equal(ping.accept(makeMessage("hello")), false);
  assert.equal(ping.accept(makeMessage("")), false);
  assert.equal(ping.accept({ content: undefined }), false);
  assert.equal(ping.accept(null), false);
});

test("ping replies 'Pong' to the sender's source hash", async () => {
  const { deliver, calls } = makeDeliver();
  await ping.handle(makeMessage("ping"), {}, deliver);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].destHash, SOURCE_HEX);
  assert.equal(calls[0].content, "Pong");
});

test("ping forwards the arrival link id so the reply rides back over it", async () => {
  const { deliver, calls } = makeDeliver();
  const linkId = new Uint8Array(8).fill(3);
  await ping.handle(makeMessage("ping"), {}, deliver, {}, linkId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].linkId, linkId, "link id threaded into deliver");
});

test("isFromCrew returns true when the source matches a crew destination", () => {
  const settings = { crew: [{ name: "Alice", destination: SOURCE_HEX }] };
  assert.equal(isFromCrew(makeMessage("ping"), settings), true);
});

test("isFromCrew is case-insensitive with the configured destination", () => {
  const settings = {
    crew: [{ name: "Alice", destination: SOURCE_HEX.toUpperCase() }],
  };
  assert.equal(isFromCrew(makeMessage("ping"), settings), true);
});

test("isFromCrew returns false for unknown senders", () => {
  const other = new Uint8Array(16).fill(1);
  const settings = { crew: [{ name: "Alice", destination: SOURCE_HEX }] };
  assert.equal(isFromCrew(makeMessage("ping", other), settings), false);
});

test("isFromCrew matches a crew member configured by identity hash via the derived lxmf.delivery hash", () => {
  // The crew member is configured by their protocol-agnostic Reticulum
  // identity hash; the inbound LXMF message's sourceHash is the sender's
  // lxmf.delivery destination hash (what travels on the wire). isFromCrew
  // derives the destination hash from the configured identity and compares.
  const identityHash = "7a3c9f1b2e4d58607a3c9f1b2e4d5860";
  const derivedLxmfHash = deriveLxmfDestinationHash(identityHash);
  const settings = { crew: [{ name: "Alice", identity: identityHash }] };
  assert.equal(
    isFromCrew(makeMessage("ping", fromHex(derivedLxmfHash)), settings),
    true,
  );
  // The raw identity hash itself is NOT what arrives on the wire, so a
  // message sourced from the identity hash must not match.
  assert.equal(
    isFromCrew(makeMessage("ping", fromHex(identityHash)), settings),
    false,
  );
});

test("isFromCrew returns false when no crew is configured", () => {
  assert.equal(isFromCrew(makeMessage("ping"), {}), false);
  assert.equal(isFromCrew(makeMessage("ping"), undefined), false);
  assert.equal(isFromCrew(null, { crew: [] }), false);
});

test("handleMessage dispatches a matching ping and replies", async () => {
  const { deliver, calls } = makeDeliver();
  const debugs = [];
  const app = { debug: (...a) => debugs.push(a.join(" ")) };

  await handleMessage(makeMessage("PING"), {}, deliver, app);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].destHash, SOURCE_HEX);
  assert.equal(calls[0].content, "Pong");
  assert.ok(debugs.some((m) => /handled by command "ping"/.test(m)));
});

test("handleMessage forwards the arrival link id to the command's reply", async () => {
  const { deliver, calls } = makeDeliver();
  const linkId = new Uint8Array(8).fill(6);

  await handleMessage(makeMessage("ping"), {}, deliver, {}, linkId);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].linkId,
    linkId,
    "arrival link threaded through to the reply",
  );
});

test("handleMessage does not reply to unmatched messages", async () => {
  const { deliver, calls } = makeDeliver();
  await handleMessage(makeMessage("unknown"), {}, deliver, {});
  assert.equal(calls.length, 0);
});

test("handleMessage does nothing without a deliver callback", async () => {
  const { calls } = makeDeliver();
  await handleMessage(makeMessage("ping"), {}, undefined, {});
  assert.equal(calls.length, 0);
});

test("handleMessage swallows errors thrown by a command", async () => {
  const { deliver } = makeDeliver();
  // Temporarily replace ping with a failing implementation.
  const original = commands.ping;
  commands.ping = {
    crewOnly: false,
    accept: () => true,
    handle: () => {
      throw new Error("boom");
    },
  };
  const errors = [];
  const app = { error: (...a) => errors.push(a.join(" ")) };

  await handleMessage(makeMessage("ping"), {}, deliver, app);

  assert.ok(errors.some((m) => /failed: boom/.test(m)));
  commands.ping = original;
});
