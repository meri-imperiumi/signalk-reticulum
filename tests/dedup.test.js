const test = require("node:test");
const assert = require("node:assert/strict");

const { toHex } = require("@reticulum/core");
const {
  DEFAULT_CAPACITY,
  makeRecentFilter,
  messageKey,
} = require("../plugin/dedup");

// --- makeRecentFilter -------------------------------------------------------

test("makeRecentFilter reports the first sighting as new and repeats as seen", () => {
  const seen = makeRecentFilter();
  assert.equal(seen("a"), true, "first sighting is new");
  assert.equal(seen("a"), false, "second sighting is a duplicate");
  assert.equal(seen("a"), false, "still a duplicate");
  assert.equal(seen("b"), true, "a different key is new");
});

test("makeRecentFilter evicts the least recently used key beyond capacity", () => {
  const seen = makeRecentFilter(2);
  assert.equal(seen("a"), true);
  assert.equal(seen("b"), true);
  // Refresh "a" so "b" becomes the least recently used entry.
  assert.equal(seen("a"), false);
  assert.equal(seen("c"), true, 'pushes "b" out, not "a"');
  assert.equal(
    seen("b"),
    true,
    '"b" was evicted (the refresh kept "a" alive), so it looks new again',
  );
  assert.equal(seen("c"), false, '"c" is still remembered');
});

test("makeRecentFilter falls back to the default capacity on bad input", () => {
  const seen = makeRecentFilter(0);
  for (let i = 0; i < DEFAULT_CAPACITY + 10; i += 1) {
    seen(`key-${i}`);
  }
  assert.equal(seen("key-0"), true, "oldest key was evicted at capacity");
  assert.equal(
    seen(`key-${DEFAULT_CAPACITY + 9}`),
    false,
    "newest key is still remembered",
  );
});

// --- messageKey -------------------------------------------------------------

test("messageKey derives the hex message id from an inbound message", () => {
  const id = new Uint8Array(32).fill(0xab);
  assert.equal(messageKey({ messageId: id }, toHex), toHex(id));
});

test("messageKey returns null when the message carries no id", () => {
  // Synthetic dispatches (and any message that somehow lacks an id) must not
  // be deduplicated on a weaker key: dropping a distinct message that happens
  // to share source and content would be worse than a duplicate reply.
  assert.equal(messageKey({}, toHex), null);
  assert.equal(messageKey({ messageId: null }, toHex), null);
  assert.equal(messageKey({ messageId: new Uint8Array(0) }, toHex), null);
  assert.equal(messageKey(null, toHex), null);
});
