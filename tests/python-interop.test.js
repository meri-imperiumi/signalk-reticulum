const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const { toHex } = require("@reticulum/core");
const { LocalClientInterface } = require("@reticulum/node");

const makePlugin = require("../plugin/index.js");

/**
 * End-to-end Python interop smoketest: the full crew-delivery path of the
 * plugin (announce ingestion, ping/pong, telemetry snapshots, alert
 * forwarding) against a **real Python rnsd** and a **real Python LXMF
 * client** — the two components the boat actually runs. JS-only test doubles
 * cannot catch wire-format or daemon-behaviour regressions in @reticulum/*,
 * which is how the 0.6.0 breakage slipped through: every existing
 * integration test passed against the unfixed stack because both sides were
 * reticulum-js.
 *
 * Topology (mirrors the boat):
 *
 *   [plugin (JS, shared-instance client)] <-- rnsd (Python) --> [crew (Python
 *   LXMF client, TCP mesh interface)] — the crew connects to rnsd over a TCP
 *   interface like a radio-mesh peer, not as a shared-instance client.
 *
 * Asserts, in order:
 *   1. the crew's announce is ingested (identity + route learned) — the
 *      field failure behind "destinationsKnown stays low" blackholes every
 *      plugin-initiated delivery
 *   2. the crew's ping is answered with "Pong"
 *   3. a telemetry snapshot reaches the crew
 *   4. an alarm notification is forwarded to the crew as an LXMF message —
 *      the plugin's most important feature
 *
 * Self-skips when python3, the RNS/LXMF Python packages or the rnsd binary
 * are unavailable (e.g. CI), the same pattern as the other real-integration
 * smoketests.
 */

/** Picks a free TCP port by binding port 0 and releasing it again. */
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** Waits until a TCP port accepts connections, or throws after `timeoutMs`. */
async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Port ${port} never became reachable`);
}

/** Waits for `predicate()` to return truthy, polling every `intervalMs`. */
async function waitFor(predicate, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Minimal Signal K ServerAPI stand-in (see tests/plugin.test.js). */
function makeApp(dataDir) {
  const app = {
    /** @type {{onDelta:(delta:any)=>void, onError:(err:unknown)=>void}[]} */
    _handlers: [],
    debug(...args) {
      if (process.env.PLUGIN_INTEROP_DEBUG) {
        console.log("PLUGIN:", ...args);
      }
    },
    setPluginStatus() {},
    setPluginError(msg) {
      if (process.env.PLUGIN_INTEROP_DEBUG) console.log("PLUGIN error:", msg);
    },
    savePluginOptions(_options, cb) {
      if (cb) setImmediate(cb, null);
    },
    subscriptionmanager: {
      subscribe(_spec, _unsubs, onError, onDelta) {
        app._handlers.push({ onDelta, onError });
      },
    },
    _onDelta(delta) {
      for (const { onDelta } of app._handlers) {
        try {
          onDelta(delta);
        } catch {
          /* best effort */
        }
      }
    },
    handleMessage() {},
    getDataDirPath() {
      return dataDir;
    },
    getSelfPath(p) {
      const self = {
        name: "Test Boat",
        navigation: {
          position: { latitude: 60.1234, longitude: 21.9876 },
          speedOverGround: { value: 5.2 },
          courseOverGroundTrue: { value: 1.2 },
        },
        electrical: {
          batteries: {
            house: { capacity: { value: 400 }, stateOfCharge: { value: 0.82 } },
          },
        },
      };
      return p
        .split(".")
        .filter(Boolean)
        .reduce((o, k) => (o ? o[k] : undefined), self);
    },
    putSelfPath() {},
  };
  return app;
}

/**
 * Runs the whole suite as one test: the components share a directory and
 * subprocesses, so splitting them would double the (real-daemon) runtime.
 */
test("crew delivery interop against a real Python rnsd and LXMF client", {
  timeout: 180_000,
}, async () => {
  // --- Self-skip without the Python side --------------------------------
  const python = process.env.PYTHON_INTEROP_PYTHON || "python3";
  const probe = spawnSync(python, ["-c", "import RNS, LXMF"], {
    encoding: "utf8",
  });
  const rnsdProbe = spawnSync("rnsd", ["--help"], { encoding: "utf8" });
  if (probe.status !== 0 || rnsdProbe.error) {
    console.log(
      "Skipping: python3 with RNS/LXMF and a rnsd binary are required " +
        `(${python} import status: ${probe.status}, rnsd: ${rnsdProbe.error ? rnsdProbe.error.code : "present"})`,
    );
    return;
  }

  // --- Isolated environment ----------------------------------------------
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-interop-"));
  const rnsdConfigDir = path.join(workDir, "rnsd-config");
  const crewConfigDir = path.join(workDir, "crew-config");
  const pluginDataDir = path.join(workDir, "plugin-data");
  for (const dir of [rnsdConfigDir, crewConfigDir, pluginDataDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sharedInstancePort = await ephemeralPort();
  const controlPort = await ephemeralPort();
  const meshPort = await ephemeralPort();

  fs.writeFileSync(
    path.join(rnsdConfigDir, "config"),
    [
      "[reticulum]",
      "share_instance = Yes",
      "shared_instance_type = tcp",
      `shared_instance_port = ${sharedInstancePort}`,
      `instance_control_port = ${controlPort}`,
      "",
      "[interfaces]",
      "  [[TCP Server Interface]]",
      "    type = TCPServerInterface",
      "    enabled = Yes",
      "    listen_ip = 127.0.0.1",
      `    listen_port = ${meshPort}`,
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(crewConfigDir, "config"),
    [
      "[reticulum]",
      "share_instance = No",
      `instance_control_port = ${await ephemeralPort()}`,
      "",
      "[interfaces]",
      "  [[TCP Interface]]",
      "    type = TCPClientInterface",
      "    enabled = Yes",
      "    target_host = 127.0.0.1",
      `    target_port = ${meshPort}`,
      "",
    ].join("\n"),
  );

  // --- Launch rnsd --------------------------------------------------------
  const rnsd = spawn("rnsd", ["--config", rnsdConfigDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let rnsdErr = "";
  rnsd.stderr.on("data", (d) => {
    rnsdErr += d;
  });
  await waitForPort(sharedInstancePort, 15000);
  await waitForPort(meshPort, 15000);

  // --- Launch the Python crew client -------------------------------------
  const crew = spawn(
    python,
    [
      path.join(__dirname, "fixtures", "python_interop_crew.py"),
      crewConfigDir,
      workDir,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  /** @type {{type:string, title?:string, content?:string}[]} */
  const crewLines = [];
  let crewBuffer = "";
  let crewErr = "";
  crew.stdout.on("data", (d) => {
    crewBuffer += d;
    const lines = crewBuffer.split("\n");
    crewBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        crewLines.push(JSON.parse(line));
      } catch {
        /* ignore non-JSON noise */
      }
    }
  });
  crew.stderr.on("data", (d) => {
    crewErr += d;
  });

  const crewInfo = await waitFor(
    () => crewLines.find((l) => l.type === "ready"),
    20000,
    "crew client startup",
  );
  assert.ok(crewInfo.identity, "crew identity hash advertised");
  assert.ok(crewInfo.dest, "crew lxmf.delivery hash advertised");

  // --- Start the real plugin against the repro rnsd ----------------------
  const deps = makePlugin.deps;
  const originalConnect = deps.connectSharedInstance;
  deps.connectSharedInstance = async () => {
    const iface = new LocalClientInterface({
      host: "127.0.0.1",
      port: sharedInstancePort,
      name: "Shared Instance",
    });
    await iface.connect();
    return iface;
  };

  const app = makeApp(pluginDataDir);
  let plugin;
  try {
    plugin = makePlugin(app);
    await plugin.start({
      messaging: {
        send_alerts: true,
        digital_switching: false,
        display_name: "Test Boat",
      },
      crew: [{ name: "Crew", identity: crewInfo.identity }],
      telemetry: {
        enabled: true,
        interval_seconds: 30,
        populate_crew_telemetry: false,
      },
      use_shared_instance: true,
    });

    // Hand the crew the plugin's lxmf.delivery hash so it starts pinging
    await waitFor(
      () => plugin.lxmf && plugin.lxmf.deliveryDest,
      20000,
      "plugin messaging",
    );
    fs.writeFileSync(
      path.join(workDir, "plugin.json"),
      JSON.stringify({
        dest: toHex(plugin.lxmf.deliveryDest.destinationHash),
      }),
    );

    // 1. The crew's announce must be ingested: identity + route learned.
    //    A blackholed announce path is exactly the "destinationsKnown
    //    stays low / nothing works after a fresh start" failure mode.
    await waitFor(
      () =>
        plugin.rns.transport.routingTable.routes.has(crewInfo.dest) &&
        plugin.rns.transport.routingTable.routes.size >= 1,
      60000,
      "crew announce ingestion (route learned)",
    );

    // 2. Ping -> Pong
    await waitFor(
      () => crewLines.find((l) => l.type === "message" && l.content === "Pong"),
      60000,
      "ping answered with Pong",
    );

    // 3. Telemetry snapshot (empty-content message carrying FIELD_TELEMETRY)
    await waitFor(
      () => crewLines.find((l) => l.type === "message" && l.content === ""),
      60000,
      "telemetry snapshot delivery",
    );

    // 4. Alert forwarding — the plugin's most important feature
    app._onDelta({
      updates: [
        {
          values: [
            {
              path: "notifications.electrical.bilge",
              value: { state: "alarm", message: "Bilge high!" },
            },
          ],
        },
      ],
    });
    const alert = await waitFor(
      () =>
        crewLines.find(
          (l) =>
            l.type === "message" && (l.content || "").includes("Bilge high!"),
        ),
      60000,
      "alert delivery",
    );
    assert.ok(alert, "alert message received by crew");
  } finally {
    deps.connectSharedInstance = originalConnect;
    try {
      if (plugin) await plugin.stop();
    } catch {
      /* best effort */
    }
    crew.kill();
    rnsd.kill();
    fs.rmSync(workDir, { recursive: true, force: true });
    if (rnsdErr.trim()) {
      console.log("rnsd stderr tail:", rnsdErr.slice(-500));
    }
    if (crewErr.trim()) {
      console.log("crew stderr tail:", crewErr.slice(-500));
    }
  }
});
