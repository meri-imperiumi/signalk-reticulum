const test = require("node:test");
const assert = require("node:assert/strict");

const { watchReconnects } = require("../plugin/announce");

/**
 * Smoketests for {@link watchReconnects}: the interface-reconnect watcher that
 * triggers an immediate re-announce of every destination when a connection is
 * re-established — the plugin-side counterpart of the Python reference's
 * `Transport.shared_connection_reappeared()` (re-announce every registered
 * SINGLE destination the moment the shared-instance connection comes back, so
 * the daemon does not drop peers' traffic for us until the next periodic
 * announce).
 *
 * The interfaces are plain EventTargets (the only surface the watcher needs);
 * the onReconnect callback is a spy.
 */

/** A minimal EventTarget-shaped interface fake. */
function makeIface(name = "fake-iface") {
  const iface = new EventTarget();
  iface.name = name;
  iface.disconnect = async () => {};
  return iface;
}

test("watchReconnects fires onReconnect when an interface reconnects", () => {
  const iface = makeIface("shared-instance");
  let fired = 0;
  const stop = watchReconnects({
    interfaces: [iface],
    onReconnect: () => {
      fired += 1;
    },
    minIntervalMs: 0,
    log: () => {},
  });

  try {
    iface.dispatchEvent(new CustomEvent("connected"));
    assert.equal(fired, 1, "reconnect fired the callback");
  } finally {
    stop();
  }
});

test("watchReconnects debounces bursts across interfaces", () => {
  const a = makeIface("a");
  const b = makeIface("b");
  let fired = 0;
  const stop = watchReconnects({
    interfaces: [a, b],
    onReconnect: () => {
      fired += 1;
    },
    minIntervalMs: 60_000,
    log: () => {},
  });

  try {
    a.dispatchEvent(new CustomEvent("connected"));
    assert.equal(fired, 1, "first reconnect fires");
    b.dispatchEvent(new CustomEvent("connected"));
    assert.equal(fired, 1, "second reconnect inside the window is debounced");
  } finally {
    stop();
  }
});

test("watchReconnects stop() detaches every listener", () => {
  const iface = makeIface();
  let fired = 0;
  const stop = watchReconnects({
    interfaces: [iface],
    onReconnect: () => {
      fired += 1;
    },
    minIntervalMs: 0,
    log: () => {},
  });

  stop();
  iface.dispatchEvent(new CustomEvent("connected"));
  assert.equal(fired, 0, "no callback after stop()");
});

test("watchReconnects logs the reconnect and skips non-EventTarget entries", () => {
  const iface = makeIface("shared-instance");
  const logs = [];
  let fired = 0;
  const stop = watchReconnects({
    interfaces: [null, {}, iface],
    onReconnect: () => {
      fired += 1;
    },
    minIntervalMs: 0,
    log: (msg) => logs.push(msg),
  });

  try {
    iface.dispatchEvent(new CustomEvent("connected"));
    assert.equal(fired, 1);
    assert.ok(
      logs.some((l) => /re-established.*re-announcing/.test(l)),
      `reconnect logged: ${logs.join(" | ")}`,
    );
  } finally {
    stop();
  }
});
