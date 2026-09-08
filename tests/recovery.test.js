const test = require("node:test");
const assert = require("node:assert");

const {
  withTimeout,
  startLagMonitor,
  watchOutboundFreeze,
} = require("../plugin/recovery");

/** A tiny wait helper. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("withTimeout resolves with the wrapped value when fast", async () => {
  const value = await withTimeout(async () => 42, 1000, "fast op");
  assert.strictEqual(value, 42);
});

test("withTimeout rejects when the operation hangs", async () => {
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), 50, "hung op"),
    /hung op timed out after 50ms/,
  );
});

test("startLagMonitor reports non-negative lag samples", async () => {
  let samples = 0;
  const stop = startLagMonitor({
    pollMs: 20,
    onSample: (lagMs) => {
      samples += 1;
      assert.ok(typeof lagMs === "number" && lagMs >= 0);
    },
  });
  try {
    await wait(70);
    assert.ok(samples >= 2, `expected samples, got ${samples}`);
  } finally {
    stop();
  }
  const count = samples;
  await wait(50);
  assert.strictEqual(samples, count, "stop() halts sampling");
});

/** Builds a fake interface with controllable online/txb. */
function fakeIface({ txb = 0, online = true } = {}) {
  return { txb, online, name: "fake", disconnect: async () => {} };
}

test("watchOutboundFreeze probes, then recycles a frozen interface", async () => {
  const txb = 100;
  const wedged = {
    txb,
    online: true,
    name: "wedged",
    disconnect: async () => {},
  };
  const probes = [];
  const swaps = [];
  const freshTxb = { value: 5 };
  const fresh = {
    get txb() {
      return freshTxb.value++;
    },
    online: true,
    name: "fresh",
    disconnect: async () => {},
  };
  const interfaces = [
    {
      iface: wedged,
      label: "test",
      buildReplacement: async (old) => {
        swaps.push(old);
        return fresh;
      },
    },
  ];
  const watchdog = watchOutboundFreeze({
    interfaces,
    probeAnnounce: () => {
      probes.push(Date.now());
    },
    stallAfterMs: 90,
    probeGraceMs: 70,
    cooldownMs: 0,
    pollMs: 25,
    log: () => {},
    onSwapped: (label) => swaps.push(`swapped:${label}`),
  });
  try {
    await wait(90 + 70 + 250);
    assert.strictEqual(probes.length, 1, "probe announce fired once");
    assert.strictEqual(watchdog.recycleCount(), 1, "interface recycled");
    assert.strictEqual(
      interfaces[0].iface,
      fresh,
      "entry now tracks the fresh iface",
    );
    assert.ok(swaps.includes("swapped:test"));
  } finally {
    watchdog.stop();
  }
});

test("watchOutboundFreeze leaves flowing and offline interfaces alone", async () => {
  let txb = 0;
  const flowing = {
    get txb() {
      return ++txb;
    },
    online: true,
    name: "flowing",
  };
  const offline = { txb: 0, online: false, name: "offline" };
  const probes = [];
  const watchdog = watchOutboundFreeze({
    interfaces: [
      { iface: flowing, label: "flowing", buildReplacement: async () => null },
      { iface: offline, label: "offline", buildReplacement: async () => null },
    ],
    probeAnnounce: () => probes.push(1),
    stallAfterMs: 60,
    probeGraceMs: 20,
    cooldownMs: 0,
    pollMs: 20,
    log: () => {},
  });
  try {
    await wait(220);
    assert.strictEqual(probes.length, 0);
    assert.strictEqual(watchdog.recycleCount(), 0);
  } finally {
    watchdog.stop();
  }
});

test("watchOutboundFreeze cooldown prevents rapid re-swaps", async () => {
  const frozen = { txb: 0, online: true, name: "frozen" };
  const fresh1 = { txb: 0, online: true, name: "fresh1" };
  const fresh2 = { txb: 0, online: true, name: "fresh2" };
  const replacements = [fresh1, fresh2];
  let probes = 0;
  const watchdog = watchOutboundFreeze({
    interfaces: [
      {
        iface: frozen,
        label: "frozen",
        buildReplacement: async () => replacements.shift() ?? null,
      },
    ],
    probeAnnounce: () => {
      probes += 1;
    },
    stallAfterMs: 50,
    probeGraceMs: 20,
    // Long cooldown: the second freeze must not swap again.
    cooldownMs: 60_000,
    pollMs: 15,
    log: () => {},
  });
  try {
    await wait(400);
    assert.strictEqual(
      watchdog.recycleCount(),
      1,
      "only one swap despite re-freeze",
    );
    assert.ok(probes >= 1);
  } finally {
    watchdog.stop();
  }
});

test("a probe that unblocks the interface avoids the swap", async () => {
  // Simulates a timer/announce-loop stall: the probe announce itself
  // produces traffic, so no recycle is needed.
  const iface = { txb: 0, online: true, name: "slow" };
  let probes = 0;
  const watchdog = watchOutboundFreeze({
    interfaces: [
      {
        iface,
        label: "slow",
        buildReplacement: async () => {
          throw new Error("must not swap");
        },
      },
    ],
    probeAnnounce: () => {
      probes += 1;
      iface.txb += 10; // the probe announce moves bytes
    },
    stallAfterMs: 50,
    probeGraceMs: 30,
    cooldownMs: 0,
    pollMs: 15,
    log: () => {},
  });
  try {
    await wait(300);
    assert.ok(probes >= 1);
    assert.strictEqual(watchdog.recycleCount(), 0);
  } finally {
    watchdog.stop();
  }
});

// ---------------------------------------------------------------------------
// Real-integration smoketest: the real swap machinery (teardown, reconnect,
// transport re-attach) recovers an interface whose socket stopped moving
// bytes. The wedge is simulated at the socket-counter level (a genuinely
// backpressured loopback kernel buffer needs megabytes); the interfaces,
// Reticulum node, connections and post-recovery delivery are all real.
// ---------------------------------------------------------------------------
const net = require("node:net");
const { Reticulum, Destination, Packet } = require("@reticulum/core");
const {
  DestType,
  HeaderType,
  PacketType,
} = require("@reticulum/core/src/core/packet.js");
const { LocalClientInterface } = require("@reticulum/node");

test("smoketest: frozen shared-instance client is recycled and transmits again", async () => {
  const connections = [];
  const serverBytes = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    let bytes = 0;
    socket.on("data", (d) => {
      bytes += d.length;
    });
    serverBytes.push(() => bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const rns = new Reticulum({ logLevel: "error" });
  const connect = () =>
    LocalClientInterface.connectToSharedInstance({
      port,
      reconnectWait: 1,
    });

  const first = await connect();
  assert.ok(first, "initial connection established");
  rns.addInterface(first, true);

  // Simulate a wedged socket: freeze the counter the watchdog samples. The
  // property keeps a setter so the interface's own connect/reconnect code
  // can still assign its socket, and the real socket is kept for teardown.
  const realSocket = first.socket;
  const frozenSocket = { bytesWritten: Number(realSocket.bytesWritten) || 0 };
  let socketBacking = realSocket;
  Object.defineProperty(first, "socket", {
    get: () => frozenSocket,
    set: (v) => {
      socketBacking = v;
    },
    configurable: true,
  });

  const makePacket = () =>
    new Packet({
      headerType: HeaderType.HEADER_1,
      hops: 0,
      transportType: 0,
      destinationType: DestType.PLAIN,
      packetType: PacketType.DATA,
      contextFlag: false,
      destinationHash: new Uint8Array(16).fill(0),
      contextByte: 0,
      payload: new TextEncoder().encode("recovery smoketest"),
    });

  const probeAnnounce = () => {
    rns.transport.broadcast(makePacket());
  };

  const watchdog = watchOutboundFreeze({
    interfaces: [
      {
        iface: first,
        label: "shared-instance",
        buildReplacement: async (oldIface) => {
          try {
            rns.removeInterface(oldIface);
          } catch {}
          try {
            await oldIface.disconnect();
          } catch {}
          try {
            realSocket.destroy();
          } catch {}
          const fresh = await connect();
          if (fresh) {
            rns.addInterface(fresh, true);
            return fresh;
          }
          return null;
        },
      },
    ],
    probeAnnounce,
    stallAfterMs: 700,
    probeGraceMs: 400,
    cooldownMs: 0,
    pollMs: 150,
    log: () => {},
  });

  try {
    const driver = setInterval(probeAnnounce, 150);
    await new Promise((resolve) => setTimeout(resolve, 3600));
    clearInterval(driver);

    assert.ok(watchdog.recycleCount() >= 1, "interface was recycled");
    assert.strictEqual(
      connections.length,
      2,
      "a replacement connection was made",
    );

    // Post-recovery: broadcasts must reach the new server connection.
    const bytesBefore = serverBytes[1]();
    probeAnnounce();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(
      serverBytes[1]() > bytesBefore,
      "bytes flow on the replacement connection after the swap",
    );
  } finally {
    watchdog.stop();
    await rns.stop().catch(() => {});
    for (const c of connections) c.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}, 30000);
