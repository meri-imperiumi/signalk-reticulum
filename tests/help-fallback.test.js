const test = require("node:test");
const assert = require("node:assert/strict");

const { commands, handleMessage } = require("../plugin/commands");
const help = require("../plugin/commands/help");
const fallback = require("../plugin/commands/fallback");

const SOURCE = new Uint8Array(16).fill(5);

/** A recording deliver callback: `deliver(dest, title, content, linkId, opts)`. */
function makeDeliver() {
  const calls = [];
  const deliver = async (destHash, title, content, linkId, opts) => {
    calls.push({ destHash, title, content, linkId, opts });
  };
  return { deliver, calls };
}

/** An app fake whose crew settings resolve the sender as crew. */
const CREW_SETTINGS = {
  crew: [{ name: "Crew", destination: Buffer.from(SOURCE).toString("hex") }],
};

test("the help command is registered and public", () => {
  assert.equal(commands.help, help);
  assert.equal(help.crewOnly, false);
  assert.equal(help.example, "Help");
});

test("help accepts 'Help' with casing and whitespace variants", () => {
  assert.equal(help.accept({ content: "help" }), true);
  assert.equal(help.accept({ content: "  HELP " }), true);
  assert.equal(help.accept({ content: "status" }), false);
  assert.equal(help.accept({ content: "help me" }), false);
  assert.equal(help.accept(null), false);
});

test("help lists only the public commands for a stranger", async () => {
  const { deliver, calls } = makeDeliver();
  await help.handle({ content: "help", sourceHash: SOURCE }, {}, deliver);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { markdown: true });
  const lines = calls[0].content.split("\n");
  assert.match(lines[0], /Automated boat node/);
  assert.deepEqual(
    lines.slice(1),
    ["- Ping", "- Status", "- Help"],
    "crew-only commands are not listed",
  );
});

test("help lists the crew-only commands too for crew", async () => {
  const { deliver, calls } = makeDeliver();
  await help.handle(
    { content: "help", sourceHash: SOURCE },
    CREW_SETTINGS,
    deliver,
  );
  const examples = calls[0].content
    .split("\n")
    .slice(1)
    .map((line) => line.slice(2));
  assert.deepEqual(examples, [
    "Ping",
    "Status",
    "Briefing",
    "Subscribe briefing",
    "Unsubscribe briefing",
    "Turn <switch name> on",
    "Log <text>",
    "Help",
  ]);
});

test("a stranger sending 'Briefing' gets the fallback, never the briefing", async () => {
  fallback.reset();
  const { deliver, calls } = makeDeliver();
  await handleMessage({ content: "Briefing", sourceHash: SOURCE }, {}, deliver);
  assert.equal(calls.length, 1, "one fallback reply");
  assert.match(calls[0].content, /Automated boat node/);
  assert.ok(
    !calls[0].content.includes("Passage briefing"),
    "no briefing content leaks to non-crew",
  );
});

test("crew sending an unknown command get the fallback with the crew commands", async () => {
  fallback.reset();
  const { deliver, calls } = makeDeliver();
  await handleMessage(
    { content: "frobnicate", sourceHash: SOURCE },
    CREW_SETTINGS,
    deliver,
  );
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].content.includes("Briefing"),
    "crew list includes Briefing",
  );
});

test("the fallback reply is rate limited per sender", async () => {
  fallback.reset();
  const { deliver, calls } = makeDeliver();
  await handleMessage({ content: "xyz", sourceHash: SOURCE }, {}, deliver);
  await handleMessage({ content: "xyz", sourceHash: SOURCE }, {}, deliver);
  assert.equal(calls.length, 1, "second message within the hour stays silent");

  // A different sender gets their own reply.
  await handleMessage(
    { content: "xyz", sourceHash: new Uint8Array(16).fill(7) },
    {},
    deliver,
  );
  assert.equal(calls.length, 2);
  fallback.reset();
});

test("a delivery failure does not burn the sender's rate-limit slot", async () => {
  fallback.reset();
  let fail = true;
  const deliver = async () => {
    if (fail) {
      throw new Error("mesh down");
    }
  };
  await assert.rejects(() =>
    fallback.handle({ content: "xyz", sourceHash: SOURCE }, deliver, ["Ping"]),
  );
  fail = false;
  const sent = await fallback.handle(
    { content: "xyz", sourceHash: SOURCE },
    deliver,
    ["Ping"],
  );
  assert.equal(sent, true, "retry after a failed delivery still replies");
  fallback.reset();
});

test("fallback skips messages without a source hash", async () => {
  fallback.reset();
  const { deliver, calls } = makeDeliver();
  assert.equal(
    await fallback.handle({ content: "xyz" }, deliver, ["Ping"]),
    false,
  );
  assert.equal(calls.length, 0);
  fallback.reset();
});
