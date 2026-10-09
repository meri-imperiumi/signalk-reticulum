const test = require("node:test");
const assert = require("node:assert/strict");

const { commands, handleMessage } = require("../plugin/commands");
const log = require("../plugin/commands/log");
const { fromHex } = require("@reticulum/core");
const { deriveLxmfDestinationHash } = require("../plugin/identity");

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

/** An app fake exposing a recording `logentries` resource API. */
function makeApp(failWith) {
  const writes = [];
  return {
    writes,
    resourcesApi: {
      setResource: (type, id, value) => {
        writes.push({ type, id, value });
        if (failWith) {
          return Promise.reject(failWith);
        }
        return Promise.resolve();
      },
    },
  };
}

test("the log command is registered", () => {
  assert.equal(commands.log, log);
});

test("log is crew-only", () => {
  assert.equal(log.crewOnly, true);
});

test("log accepts log messages", () => {
  assert.equal(log.accept(makeMessage("log Changed the oil")), true);
  assert.equal(log.accept(makeMessage("LOG Changed the oil")), true);
  assert.equal(log.accept(makeMessage("  log Changed the oil")), true);
});

test("log does not accept other messages", () => {
  assert.equal(log.accept(makeMessage("Ping")), false);
  assert.equal(log.accept(makeMessage("log")), false);
  // "log" followed by whitespace is required, so words merely starting with
  // it are not entries
  assert.equal(log.accept(makeMessage("logo design ideas")), false);
  assert.equal(log.accept(makeMessage("")), false);
  assert.equal(log.accept({ content: undefined }), false);
  assert.equal(log.accept(null), false);
});

test("log writes a manual entry and confirms success", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp();
  await log.handle(makeMessage("log Changed the engine oil"), {}, deliver, app);
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].type, "logentries");
  assert.match(
    app.writes[0].id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.deepEqual(app.writes[0].value, {
    text: "Changed the engine oil",
    origin: "manual",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].destHash, SOURCE_HEX);
  assert.equal(calls[0].content, "OK, logged");
});

test("log forwards the arrival link id so the reply rides back over it", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp();
  const linkId = new Uint8Array(8).fill(3);
  await log.handle(
    makeMessage("log Changed the oil"),
    {},
    deliver,
    app,
    linkId,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].linkId, linkId, "link id threaded into deliver");
});

test("log uses a hashtag as the entry category, removed from the text", async () => {
  const { deliver } = makeDeliver();
  const app = makeApp();
  await log.handle(
    makeMessage("log Changed the engine oil #maintenance"),
    {},
    deliver,
    app,
  );
  assert.deepEqual(app.writes[0].value, {
    text: "Changed the engine oil",
    origin: "manual",
    category: "maintenance",
  });
});

test("log finds hashtags at the start of the text", async () => {
  const { deliver } = makeDeliver();
  const app = makeApp();
  await log.handle(
    makeMessage("log #engine Impeller swapped"),
    {},
    deliver,
    app,
  );
  assert.deepEqual(app.writes[0].value, {
    text: "Impeller swapped",
    origin: "manual",
    category: "engine",
  });
});

test("log lowercases hashtags and removes them wherever they appear", async () => {
  const { deliver } = makeDeliver();
  const app = makeApp();
  await log.handle(
    makeMessage("log Spliced #Maintenance the halyard #rigging"),
    {},
    deliver,
    app,
  );
  assert.deepEqual(app.writes[0].value, {
    text: "Spliced the halyard",
    origin: "manual",
    category: "maintenance",
  });
});

test("log credits the configured crew name as the entry author", async () => {
  const { deliver } = makeDeliver();
  const app = makeApp();
  const settings = { crew: [{ name: "Alice", destination: SOURCE_HEX }] };
  await log.handle(makeMessage("log Changed the oil"), settings, deliver, app);
  assert.deepEqual(app.writes[0].value, {
    text: "Changed the oil",
    origin: "manual",
    author: "Alice",
  });
});

test("log matches the author by the derived lxmf.delivery hash of an identity-configured crew member", async () => {
  const { deliver } = makeDeliver();
  const app = makeApp();
  const identityHash = "7a3c9f1b2e4d58607a3c9f1b2e4d5860";
  const settings = { crew: [{ name: "Alice", identity: identityHash }] };
  await log.handle(
    makeMessage(
      "log Changed the oil",
      fromHex(deriveLxmfDestinationHash(identityHash)),
    ),
    settings,
    deliver,
    app,
  );
  assert.equal(app.writes[0].value.author, "Alice");
});

test("log leaves the entry unauthored when the crew entry has no name", async () => {
  const { deliver } = makeDeliver();
  const app = makeApp();
  // No configured name: the crew resolver falls back to the hash as the
  // label, and a hash must not end up as the logbook author
  const settings = { crew: [{ destination: SOURCE_HEX }] };
  await log.handle(makeMessage("log Changed the oil"), settings, deliver, app);
  assert.equal(app.writes[0].value.author, undefined);
});

test("log leaves the entry unauthored when the sender is not configured", async () => {
  const { deliver } = makeDeliver();
  const app = makeApp();
  await log.handle(makeMessage("log Changed the oil"), {}, deliver, app);
  assert.equal(app.writes[0].value.author, undefined);
});

test("log refuses to log a text that is only hashtags", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp();
  await log.handle(makeMessage("log #maintenance"), {}, deliver, app);
  assert.equal(app.writes.length, 0);
  assert.deepEqual(calls, [
    {
      destHash: SOURCE_HEX,
      title: "",
      content: "Nothing to log",
      linkId: undefined,
    },
  ]);
});

test("log replies when no logbook resource provider is available", async () => {
  const { deliver, calls } = makeDeliver();
  await log.handle(makeMessage("log Changed the oil"), {}, deliver, {});
  assert.deepEqual(calls, [
    {
      destHash: SOURCE_HEX,
      title: "",
      content: "Logbook not available",
      linkId: undefined,
    },
  ]);
});

test("log replies when the logbook write fails", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp(new Error("disk full"));
  await log.handle(makeMessage("log Changed the oil"), {}, deliver, app);
  assert.deepEqual(calls, [
    {
      destHash: SOURCE_HEX,
      title: "",
      content: "Logging failed: disk full",
      linkId: undefined,
    },
  ]);
});

test("handleMessage dispatches a crew log entry and replies", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp();
  const settings = { crew: [{ name: "Alice", destination: SOURCE_HEX }] };
  await handleMessage(
    makeMessage("log Changed the oil"),
    settings,
    deliver,
    app,
  );
  assert.equal(app.writes.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, "OK, logged");
});

test("handleMessage does not let a non-crew sender write logbook entries", async () => {
  const { deliver, calls } = makeDeliver();
  const app = makeApp();
  const other = new Uint8Array(16).fill(1);
  await handleMessage(
    makeMessage("log Changed the oil", other),
    {},
    deliver,
    app,
  );
  assert.equal(app.writes.length, 0);
  assert.equal(calls.length, 0);
});
