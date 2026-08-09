const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const os = require("node:os");

const { Identity, toHex } = require("@reticulum/core");
const { listInterfaces, FileStorageAdapter } = require("@reticulum/node");
const { configKeyFor, EXCLUDED_INTERFACE_IDS } = require("../plugin/schema");
const {
  PROPAGATION_ASPECT,
  RFED_NODE_ASPECTS,
  aspectNameHashesHex,
} = require("../plugin/discovery");
const makePlugin = require("../plugin/index.js");
const messaging = require("../plugin/messaging");
const nomadnet = require("../plugin/nomadnet");
const compression = require("../plugin/compression");
const rfed = require("../plugin/rfed");
const {
  buildTelemetrySensors,
  packTelemetry,
  FIELD_TELEMETRY,
} = require("../plugin/telemetry");
const { deriveLxmfDestinationHash } = require("../plugin/identity");

// --- Fakes so the plugin can be started without any real network I/O --------

/** A fake interface class that records its lifecycle. */
function makeFakeInterfaceClass(typeName, { connectThrows } = {}) {
  return class FakeInterface {
    constructor(options) {
      this.type = typeName;
      this.options = options || {};
      this.name = (options && options.name) || typeName;
    }
    async connect() {
      if (connectThrows) throw new Error(`${typeName} connect boom`);
      this.connected = true;
    }
    async disconnect() {
      this.connected = false;
    }
  };
}

class FakeRns {
  constructor(config) {
    this.config = config;
    this.added = [];
    this.removed = [];
    this.transport = new EventTarget();
    this.transport.bound = [];
    this.transport.unbound = [];
    // Mirrors Transport.has_path: whether a path is known to a destination.
    // Defaults to true so direct delivery is used unless a test records a
    // destination as unreachable via `rns.transport._unreachable`.
    this.transport._unreachable = new Set();
    this.transport.hasPath = (hash) => {
      const hex =
        hash instanceof Uint8Array ? Buffer.from(hash).toString("hex") : hash;
      return !this.transport._unreachable.has(hex);
    };
    this.transport.bindLocalDestination = (dest) => {
      this.transport.bound.push(dest);
    };
    this.transport.unbindLocalDestination = (dest) => {
      this.transport.unbound.push(dest);
    };
    this.registeredDestinations = [];
    this.deregisteredDestinations = [];
    this.persistor = {
      storeCalls: [],
      flushCalls: 0,
      async store(hash, opts) {
        this.storeCalls.push({ hash, opts });
      },
      async flush() {
        this.flushCalls += 1;
      },
    };
    this.stopped = false;
  }
  addInterface(iface, isDefault) {
    this.added.push({ iface, isDefault });
  }
  removeInterface(iface) {
    this.removed.push(iface);
  }
  registerDestination(dest) {
    this.registeredDestinations.push(dest);
  }
  deregisterDestination(dest) {
    this.deregisteredDestinations.push(dest);
  }
  // Mirrors the real Reticulum.stop(): disconnects every attached interface
  // and flushes the persistence layer.
  async stop() {
    this.stopped = true;
    for (const entry of this.added) {
      const iface = entry.iface;
      if (iface && typeof iface.disconnect === "function") {
        try {
          await iface.disconnect();
        } catch {
          /* best effort */
        }
      }
    }
    await this.persistor.flush();
  }
}

// Install fakes on the plugin's dependency seam.
makePlugin.deps.Reticulum = FakeRns;
makePlugin.deps.getInterface = (id) => {
  if (id === "auto") return makeFakeInterfaceClass("auto");
  if (id === "tcp-client") return makeFakeInterfaceClass("tcp-client");
  return undefined;
};

// Shared-instance connector override. The real factory is
// `LocalClientInterface.connectToSharedInstance` from @reticulum/node; tests
// flip `sharedState.available` to simulate a reachable rnsd. The factory only
// discovers and connects — the plugin wires the result into the transport.
const sharedState = { available: false, calls: 0 };
makePlugin.deps.connectSharedInstance = async () => {
  sharedState.calls += 1;
  if (!sharedState.available) {
    return null;
  }
  return { name: "shared-instance", async disconnect() {} };
};

// --- Fakes so the plugin's LXMF messaging can be exercised without RNS I/O ---

class FakeLxmRouter extends EventTarget {
  constructor(identity, rns) {
    super();
    this.identity = identity;
    this.rns = rns;
    this.initCalls = 0;
    this.announceCalls = [];
    this.sent = [];
    this.deliveryDest = Object.assign(new EventTarget(), {
      destinationHash: new Uint8Array(16).fill(9),
    });
    FakeLxmRouter.instances.push(this);
  }
  async init() {
    this.initCalls += 1;
  }
  async announce(name) {
    this.announceCalls.push(name);
  }
  startAnnouncingCalls = [];
  async startAnnouncing(name, options = {}) {
    this.startAnnouncingCalls.push({ name, options });
  }
  stopAnnouncingCalls = 0;
  stopAnnouncing() {
    this.stopAnnouncingCalls += 1;
  }
  async send(message, identity, linkId) {
    this.sent.push({ message, identity, linkId });
  }
  // Propagation (store-and-forward) client methods. The real LXMRouter is
  // configured with `setOutboundPropagationNode`, submits messages via
  // `submitToPropagationNode` and pulls stored messages via
  // `syncFromPropagationNode`. The fakes record the calls so the wiring can
  // be asserted without any RNS I/O.
  propagationNodeCalls = [];
  setOutboundPropagationNode(destinationHash) {
    this.propagationNodeCalls.push(destinationHash);
  }
  submitted = [];
  async submitToPropagationNode(message, identity) {
    this.submitted.push({ message, identity });
    return { transientId: new Uint8Array(16).fill(1), stampCost: 16 };
  }
  syncCalls = 0;
  async syncFromPropagationNode(identity) {
    this.syncCalls += 1;
    return { received: 0, duplicates: 0 };
  }
}
FakeLxmRouter.instances = [];

class FakeLXMessage {
  constructor(options) {
    this.options = options;
  }
}

messaging.deps.LXMRouter = FakeLxmRouter;
messaging.deps.LXMessage = FakeLXMessage;
messaging.deps.fromHex = (hex) => Buffer.from(hex, "hex");
messaging.deps.toHex = (bytes) => Buffer.from(bytes).toString("hex");

// The propagation client module has its own dependency seam; point it at the
// same fakes so store-and-forward wiring can be exercised without RNS I/O.
const propagation = require("../plugin/propagation");
propagation.deps.LXMessage = FakeLXMessage;
propagation.deps.fromHex = (hex) => Buffer.from(hex, "hex");
propagation.deps.toHex = (bytes) => Buffer.from(bytes).toString("hex");

// --- Fakes so the plugin's NomadNet site can be exercised without RNS I/O ---

class FakeNomadDestination extends EventTarget {
  constructor(name, direction, type, identity, rns) {
    super();
    this.name = name;
    this.type = type;
    this.identity = identity;
    this.rns = rns;
    this.destinationHash = new Uint8Array(16).fill(13);
    this.appData = null;
    this.registered = [];
    this.removed = [];
    this.announceCalls = 0;
    this.acceptedLinks = [];
    FakeNomadDestination.instances.push(this);
  }
  static async IN(name, type, identity, rns) {
    return new this(name, "IN", type, identity, rns);
  }
  async registerRequestHandler(path, options) {
    this.registered.push({ path, options });
    return new Uint8Array(16);
  }
  async removeRequestHandler(path) {
    this.removed.push(path);
    return true;
  }
  async announce() {
    this.announceCalls += 1;
  }
  startAnnouncingCalls = [];
  startAnnouncing(options = {}) {
    this.startAnnouncingCalls.push(options);
  }
  stopAnnouncingCalls = 0;
  stopAnnouncing() {
    this.stopAnnouncingCalls += 1;
  }
  async acceptLink(packet) {
    const link = {
      linkId: new Uint8Array(16).fill(1),
      packet,
      listeners: {},
      addEventListener(type, fn) {
        if (!link.listeners[type]) {
          link.listeners[type] = [];
        }
        link.listeners[type].push(fn);
      },
    };
    this.acceptedLinks.push(link);
    return link;
  }
}
FakeNomadDestination.instances = [];

nomadnet.deps.Destination = FakeNomadDestination;
nomadnet.deps.DestType = { SINGLE: "single" };
nomadnet.deps.Allow = { ALL: 0x01 };
nomadnet.deps.toHex = (bytes) => Buffer.from(bytes).toString("hex");

// --- Fakes so the plugin's bzip2 provider can be exercised without WASM -----

class FakeBZip2 {
  constructor() {
    this.initCalls = 0;
    this.compressCalls = [];
    this.decompressCalls = [];
  }
  async init() {
    this.initCalls += 1;
  }
  compress(data, blockSize, outLen) {
    this.compressCalls.push({ data, blockSize, outLen });
    return data;
  }
  decompress(data, size) {
    this.decompressCalls.push({ data, size });
    return data;
  }
}

compression.deps.BZip2 = FakeBZip2;

/** Minimal stand-in for the Signal K ServerAPI the plugin touches. */
function makeApp() {
  /** @type {any} */
  const app = {
    debugCalls: [],
    statusCalls: [],
    errorCalls: [],
    savedOptions: [],
    debug(...args) {
      app.debugCalls.push(args);
    },
    setPluginStatus(msg) {
      app.statusCalls.push(msg);
    },
    setPluginError(msg) {
      app.errorCalls.push(msg);
    },
    savePluginOptions(options, cb) {
      app.savedOptions.push(options);
      if (cb) setImmediate(cb, null);
    },
    subscriptionmanager: {
      subscriptions: [],
      /** @type {{onDelta:(delta:any)=>void, onError:(err:unknown)=>void}[]} */
      _handlers: [],
      subscribe(spec, unsubs, onError, onDelta) {
        app.subscriptionmanager.subscriptions.push(spec);
        app.subscriptionmanager._handlers.push({ onDelta, onError });
        unsubs.push(() => {
          app.subscriptionmanager.unsubscribed = true;
        });
      },
    },
    /**
     * Dispatches a delta to every registered subscription handler, mirroring
     * how the real Signal K server fans one delta out to all matching
     * subscriptions (so the plugin's notifications and connectivity
     * subscriptions both receive it).
     */
    _onDelta(delta) {
      for (const { onDelta } of app.subscriptionmanager._handlers) {
        try {
          onDelta(delta);
        } catch {
          /* best effort, matches server delivery semantics */
        }
      }
    },
    _onError(err) {
      for (const { onError } of app.subscriptionmanager._handlers) {
        try {
          onError(err);
        } catch {
          /* best effort */
        }
      }
    },
    /** Captures `app.handleMessage(pluginId, delta)` calls so tests can assert
     * on the deltas the plugin publishes (e.g. inbound crew telemetry). */
    messages: [],
    handleMessage(id, delta) {
      app.messages.push({ id, delta });
    },
  };
  return app;
}

/** Like {@link makeApp} but also exposes a writable plugin data directory. */
function makeAppWithDataDir() {
  const app = makeApp();
  // Signal K's real getDataDirPath() returns a stable path; compute it once
  // so repeated calls (plugin start + assertions) compare equal.
  const dir = join(os.tmpdir(), `sk-reticulum-${process.pid}-${Date.now()}`);
  app.getDataDirPath = () => dir;
  return app;
}

test("the plugin module exports a constructor that returns a plugin object", () => {
  const plugin = makePlugin(makeApp());

  assert.equal(typeof plugin, "object");
  assert.equal(plugin.id, "signalk-reticulum");
  assert.equal(typeof plugin.name, "string");
  assert.equal(typeof plugin.start, "function");
  assert.equal(typeof plugin.stop, "function");
  assert.equal(typeof plugin.schema, "function");
});

test("schema exposes one instance array per configurable registry type", () => {
  const plugin = makePlugin(makeApp());
  const schema = plugin.schema();

  const configurable = listInterfaces().filter(
    (e) => !EXCLUDED_INTERFACE_IDS.includes(e.id),
  );

  // One array per type (minus the browser-only ones), keyed by configKeyFor.
  for (const entry of configurable) {
    const key = configKeyFor(entry.id);
    const array = schema.properties[key];
    assert.equal(array.type, "array", `${key} is an array`);
    assert.equal(array.items.title, entry.name);
    assert.deepEqual(array.items.required, entry.schema.required || []);
    for (const prop of Object.keys(entry.schema.properties || {})) {
      assert.ok(prop in array.items.properties, `${key} preserves ${prop}`);
    }
  }
});

test("schema exposes identity and interface groups with the AutoInterface default", () => {
  const plugin = makePlugin(makeApp());
  const schema = plugin.schema();

  // The non-interface groups stay in place; the per-type interface arrays are
  // injected between use_shared_instance and identity.
  const keys = Object.keys(schema.properties);
  assert.equal(keys[0], "log_level");
  assert.equal(keys[1], "use_shared_instance");
  // The first interface array (AutoInterface) follows use_shared_instance.
  assert.equal(keys[2], configKeyFor("auto"));
  assert.deepEqual(keys.slice(keys.indexOf("identity")), [
    "identity",
    "messaging",
    "crew",
    "propagation",
    "nomadnet",
    "telemetry",
    "rfed",
    "appearance",
    "embedded_nodes",
  ]);
  const identity = schema.properties.identity;
  assert.ok("publicKey" in identity.properties);
  assert.ok("privateKey" in identity.properties);
  assert.equal(identity.properties.publicKey.readOnly, true);
});

test("start sets up the node, default AutoInterface and persists a generated identity", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);

  await plugin.start({});

  const hashHex = toHex(plugin.identity.identityHash);
  assert.ok(plugin.rns instanceof FakeRns, "Reticulum node created");
  assert.equal(plugin.interfaces.length, 1, "default AutoInterface connected");
  assert.equal(plugin.rns.added.length, 1);
  assert.equal(plugin.rns.added[0].isDefault, true);
  assert.match(app.statusCalls[0], /Identity .*?, 1 interface\(s\) connected/);
  assert.ok(
    !("logLevel" in plugin.rns.config),
    "logLevel not forwarded when unset (Reticulum default applies)",
  );

  assert.equal(app.savedOptions.length, 1);
  const saved = app.savedOptions[0];
  assert.ok(saved.identity.publicKey);
  assert.ok(saved.identity.privateKey);
  assert.equal(app.errorCalls.length, 0);
});

test("start connects explicitly configured interfaces", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);

  const source = await Identity.generate();
  const config = {
    identity: {
      privateKey: toHex(await source.getPrivateKey()),
      publicKey: toHex(await source.getPublicKey()),
    },
    interfaces: [
      { type: "tcp-client", host: "example.com", port: 4242 },
      { type: "auto", name: "lan" },
    ],
  };

  await plugin.start(config);

  assert.equal(plugin.interfaces.length, 2);
  assert.equal(plugin.interfaces[0].options.host, "example.com");
  assert.equal(plugin.interfaces[1].options.name, "lan");
  assert.equal(app.savedOptions.length, 0, "nothing persisted when keys match");
  assert.equal(app.errorCalls.length, 0);
});

test("start records interface errors and keeps the rest running", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  // A registry where tcp-client fails to connect.
  makePlugin.deps.getInterface = (id) => {
    if (id === "tcp-client")
      return makeFakeInterfaceClass("tcp-client", { connectThrows: true });
    if (id === "auto") return makeFakeInterfaceClass("auto");
    return undefined;
  };

  const source = await Identity.generate();
  await plugin.start({
    identity: {
      privateKey: toHex(await source.getPrivateKey()),
      publicKey: toHex(await source.getPublicKey()),
    },
    interfaces: [{ type: "tcp-client" }, { type: "auto" }],
  });

  assert.equal(plugin.interfaces.length, 1, "auto still connected");
  assert.equal(app.errorCalls.length, 1);
  assert.match(app.errorCalls[0], /1 failed/);
  assert.match(app.errorCalls[0], /Failed to connect "tcp-client"/);

  // Restore the default fake registry for subsequent tests.
  makePlugin.deps.getInterface = (id) => {
    if (id === "auto") return makeFakeInterfaceClass("auto");
    if (id === "tcp-client") return makeFakeInterfaceClass("tcp-client");
    return undefined;
  };
});

test("start surfaces an identity error without setting up interfaces", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);

  await plugin.start({ identity: { privateKey: "abcd" } });

  assert.equal(plugin.identity, undefined);
  assert.equal(plugin.rns, undefined);
  assert.equal(app.errorCalls.length, 1);
  assert.match(app.errorCalls[0], /Identity error/);
});

test("stop tears down every connected interface and clears state", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({});
  const rns = plugin.rns;
  const ifaces = plugin.interfaces;
  assert.ok(ifaces.length > 0);

  await plugin.stop();

  assert.equal(rns.stopped, true, "node torn down via rns.stop()");
  assert.ok(
    ifaces.every((i) => i.connected === false),
    "all interfaces disconnected",
  );
  assert.equal(plugin.rns, undefined);
  assert.equal(plugin.identity, undefined);
  assert.equal(plugin.interfaces.length, 0);
  assert.equal(app.statusCalls[app.statusCalls.length - 1], "Stopped");
});

test("start forwards a configured log level to the Reticulum node", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);

  await plugin.start({ log_level: "debug" });

  assert.equal(plugin.rns.config.logLevel, "debug");
});

test("a blank log level is ignored so the Reticulum default applies", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);

  await plugin.start({ log_level: "   " });

  assert.ok(!("logLevel" in plugin.rns.config));
});

test("start wires a bzip2 compression provider into the Reticulum node", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);

  await plugin.start({});

  const provider = plugin.rns.compressionProvider;
  assert.ok(provider, "compressionProvider set on the node");
  const data = new Uint8Array([1, 2, 3]);
  assert.deepEqual(provider.compress(data), data, "compress forwards");
  assert.deepEqual(provider.decompress(data, 3), data, "decompress forwards");
});

test("start keeps running without a compression provider when bzip2 init fails", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  const real = compression.deps.BZip2;
  compression.deps.BZip2 = class extends FakeBZip2 {
    async init() {
      throw new Error("wasm unavailable");
    }
  };

  try {
    await plugin.start({});

    assert.equal(plugin.rns.compressionProvider, undefined);
    assert.ok(
      app.debugCalls.some((args) =>
        /bzip2 provider setup failed/.test(args.join(" ")),
      ),
    );
  } finally {
    compression.deps.BZip2 = real;
  }
});

test("schema exposes a Reticulum log level selector defaulting to notice", () => {
  const plugin = makePlugin(makeApp());
  const logLevel = plugin.schema().properties.log_level;

  assert.equal(logLevel.type, "string");
  assert.equal(logLevel.default, "notice");
  assert.deepEqual(logLevel.enum, [
    "critical",
    "error",
    "warning",
    "notice",
    "info",
    "verbose",
    "debug",
  ]);
});

test("schema exposes messaging and crew configuration groups", () => {
  const plugin = makePlugin(makeApp());
  const schema = plugin.schema();

  const messagingGroup = schema.properties.messaging;
  assert.equal(messagingGroup.properties.send_alerts.default, true);
  // Empty by default so resolveDisplayName falls back to the vessel name
  // (with callsign) rather than announcing a generic placeholder.
  assert.equal(messagingGroup.properties.display_name.default, "");

  const crewGroup = schema.properties.crew;
  assert.equal(crewGroup.type, "array");
  // Crew members are configured by their protocol-agnostic Reticulum identity
  // hash; the lxmf.delivery destination hash is derived from it.
  // Only 'name' is required (identity is optional for legacy config support).
  assert.deepEqual(crewGroup.items.required, ["name"]);
  assert.equal(
    crewGroup.items.properties.identity.pattern,
    "^[0-9a-fA-F]{32}$",
  );
});

test("start brings up LXMF messaging, announces, and subscribes to notifications", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  await plugin.start({ messaging: { display_name: "My Boat" } });

  assert.ok(plugin.lxmf instanceof FakeLxmRouter, "LXMF router created");
  assert.equal(plugin.lxmf.initCalls, 1);
  // Re-announce is on by default, so the delivery destination is announced
  // via the periodic loop (which fires the first announce immediately)
  // rather than as a one-shot announce.
  assert.deepEqual(plugin.lxmf.announceCalls, []);
  assert.deepEqual(plugin.lxmf.startAnnouncingCalls, [
    { name: "My Boat", options: { intervalMs: 30 * 60 * 1000 } },
  ]);

  const subs = app.subscriptionmanager.subscriptions;
  assert.ok(
    subs.some(
      (s) =>
        s.subscribe &&
        s.subscribe.some((sub) => sub.path === "notifications.*"),
    ),
    "subscribed to notifications.*",
  );
});

test("start re-announces both LXMF and NomadNet destinations on the configured interval", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;
  FakeNomadDestination.instances.length = 0;

  await plugin.start({
    messaging: { display_name: "My Boat" },
    nomadnet: { enabled: true },
    announce: { reannounce_interval_minutes: 15 },
  });

  const intervalMs = 15 * 60 * 1000;

  // The LXMF delivery destination re-announces (no one-shot announce).
  assert.ok(plugin.lxmf instanceof FakeLxmRouter, "LXMF router created");
  const lxmf = plugin.lxmf;
  assert.deepEqual(lxmf.announceCalls, []);
  assert.deepEqual(lxmf.startAnnouncingCalls, [
    { name: "My Boat", options: { intervalMs } },
  ]);

  // The NomadNet node destination re-announces too.
  const node = FakeNomadDestination.instances[0];
  assert.equal(node.announceCalls, 0, "no one-shot NomadNet announce");
  assert.deepEqual(node.startAnnouncingCalls, [{ intervalMs }]);

  await plugin.stop();

  assert.equal(lxmf.stopAnnouncingCalls, 1, "LXMF re-announce stopped");
  assert.equal(node.stopAnnouncingCalls, 1, "NomadNet re-announce stopped");
});

test("start defaults to a 30-minute re-announce interval when unset", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  await plugin.start({ messaging: { display_name: "My Boat" } });

  assert.deepEqual(plugin.lxmf.startAnnouncingCalls, [
    { name: "My Boat", options: { intervalMs: 30 * 60 * 1000 } },
  ]);

  await plugin.stop();
});

test("start falls back to a one-shot announce when the interval is 0", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  await plugin.start({
    messaging: { display_name: "My Boat" },
    announce: { reannounce_interval_minutes: 0 },
  });

  assert.deepEqual(plugin.lxmf.announceCalls, ["My Boat"]);
  assert.equal(plugin.lxmf.startAnnouncingCalls.length, 0);
});

test("the default connectivity paths (Starlink and LTE) re-announce both destinations on change", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;
  FakeNomadDestination.instances.length = 0;

  await plugin.start({
    messaging: { display_name: "My Boat" },
    nomadnet: { enabled: true },
  });

  // One connectivity subscription watches both default paths.
  const connSub = app.subscriptionmanager.subscriptions.find(
    (s) =>
      s.context === "vessels.self" &&
      s.subscribe.some(
        (sub) => sub.path === "network.providers.starlink.status",
      ),
  );
  assert.ok(connSub, "subscribed to the default connectivity paths");
  assert.deepEqual(
    connSub.subscribe.map((s) => s.path),
    [
      "network.providers.starlink.status",
      "networking.lte.registerNetworkDisplay",
    ],
    "both default providers are watched in a single subscription",
  );

  const lxmf = plugin.lxmf;
  const node = FakeNomadDestination.instances[0];
  // Re-announce is on by default, so only the periodic loop has run — no
  // one-shot announce yet.
  assert.deepEqual(lxmf.announceCalls, []);
  assert.equal(node.announceCalls, 0);

  app._onDelta({
    updates: [
      {
        values: [
          { path: "network.providers.starlink.status", value: "online" },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The first transition triggered an immediate re-announce of both.
  assert.deepEqual(lxmf.announceCalls, ["My Boat"]);
  assert.equal(node.announceCalls, 1);

  await plugin.stop();
});

test("a repeating connectivity value does not re-announce again", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  await plugin.start({ messaging: { display_name: "My Boat" } });

  const lxmf = plugin.lxmf;

  // First transition fires.
  app._onDelta({
    updates: [
      {
        values: [
          { path: "network.providers.starlink.status", value: "online" },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(lxmf.announceCalls, ["My Boat"]);

  // Same value re-published (e.g. the Starlink plugin polling) is ignored.
  app._onDelta({
    updates: [
      {
        values: [
          { path: "network.providers.starlink.status", value: "online" },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(lxmf.announceCalls, ["My Boat"], "no extra announce");

  // A new value transitions again.
  app._onDelta({
    updates: [
      {
        values: [
          { path: "network.providers.starlink.status", value: "offline" },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(lxmf.announceCalls, ["My Boat", "My Boat"]);

  await plugin.stop();
});

test("configured connectivity paths replace the default and any of them fires", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  await plugin.start({
    messaging: { display_name: "My Boat" },
    announce: {
      connectivity_paths: [
        "networking.lte.registerNetworkDisplay",
        "communication.cellular.carrier",
      ],
    },
  });

  const subs = app.subscriptionmanager.subscriptions;
  const watched = subs.find((s) =>
    s.subscribe.some((sub) => sub.path === "communication.cellular.carrier"),
  );
  assert.ok(watched, "both configured paths are watched");
  assert.equal(
    watched.subscribe.length,
    2,
    "both paths share one subscription",
  );
  assert.ok(
    !subs.some((s) =>
      s.subscribe.some(
        (sub) => sub.path === "network.providers.starlink.status",
      ),
    ),
    "the default paths are not watched when paths are configured",
  );

  const lxmf = plugin.lxmf;

  // The non-default path also triggers a re-announce.
  app._onDelta({
    updates: [
      {
        values: [{ path: "communication.cellular.carrier", value: "Elisa" }],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(lxmf.announceCalls, ["My Boat"]);

  await plugin.stop();
});

test("an empty connectivity_paths list disables the trigger subscription", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  await plugin.start({
    messaging: { display_name: "My Boat" },
    announce: { connectivity_paths: [] },
  });

  const subs = app.subscriptionmanager.subscriptions;
  assert.ok(
    !subs.some((s) =>
      s.subscribe.some(
        (sub) => sub.path === "network.providers.starlink.status",
      ),
    ),
    "no connectivity subscription is set up",
  );

  await plugin.stop();
});

test("an alarm notification is forwarded to each crew member over LXMF", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  const dest = "0123456789abcdef0123456789abcdef";

  await plugin.start({
    messaging: { send_alerts: true },
    crew: [{ name: "Alice", destination: dest }],
  });

  const router = plugin.lxmf;
  assert.equal(router.sent.length, 0);

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

  // The forwarding is async; let it flush.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(router.sent.length, 1, "one LXMF message sent to the crew");
  const sent = router.sent[0].message.options;
  assert.deepEqual(sent.destinationHash, Buffer.from(dest, "hex"));
  assert.equal(sent.title, "Signal K: electrical.bilge");
  assert.equal(sent.content, "Bilge high!");
});

test("an emergency is forwarded, but a nominal notification is not", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  const dest = "0123456789abcdef0123456789abcdef";

  await plugin.start({
    messaging: { send_alerts: true },
    crew: [{ name: "Alice", destination: dest }],
  });
  const router = plugin.lxmf;

  app._onDelta({
    updates: [
      {
        values: [
          {
            path: "notifications.fire",
            value: { state: "emergency", message: "Fire!" },
          },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(router.sent.length, 1, "emergency forwarded");

  app._onDelta({
    updates: [
      {
        values: [
          {
            path: "notifications.fire",
            value: { state: "nominal", message: "ok" },
          },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(router.sent.length, 1, "nominal clearing not forwarded");
});

test("alerts are not forwarded when send_alerts is disabled", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);

  await plugin.start({
    messaging: { send_alerts: false },
    crew: [{ name: "Alice", destination: "0123456789abcdef0123456789abcdef" }],
  });

  app._onDelta({
    updates: [
      {
        values: [
          {
            path: "notifications.x",
            value: { state: "alarm", message: "x" },
          },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(plugin.lxmf.sent.length, 0);
});

test('an incoming "ping" LXMF message is answered with "Pong"', async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({ messaging: {} });
  const router = plugin.lxmf;
  assert.equal(router.sent.length, 0);

  const source = new Uint8Array(16).fill(4);
  router.dispatchEvent(
    new CustomEvent("message", {
      detail: { message: { sourceHash: source, content: "ping" } },
    }),
  );
  // The reply is async; let it flush.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(router.sent.length, 1, 'a "Pong" reply was sent');
  const reply = router.sent[0].message.options;
  assert.equal(reply.content, "Pong");
  assert.deepEqual(reply.destinationHash, Buffer.from(source));
});

test('an incoming "ping" that arrived over a Link is replied over that same link', async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({ messaging: {} });
  const router = plugin.lxmf;

  const source = new Uint8Array(16).fill(4);
  const linkId = new Uint8Array(8).fill(7);
  router.dispatchEvent(
    new CustomEvent("message", {
      detail: {
        message: { sourceHash: source, content: "ping" },
        link: linkId,
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(router.sent.length, 1, 'a "Pong" reply was sent');
  assert.equal(
    router.sent[0].linkId,
    linkId,
    "reply is sent over the arrival link id",
  );
});

test("an unmatched LXMF message does not trigger a reply", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({ messaging: {} });
  const router = plugin.lxmf;

  router.dispatchEvent(
    new CustomEvent("message", {
      detail: {
        message: { sourceHash: new Uint8Array(16).fill(4), content: "hello" },
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(router.sent.length, 0);
});

// --- Inbound crew telemetry -> Signal K -----------------------------------

/** Builds a packed Sideband telemetry snapshot wrapped in an LXMF fields map. */
function crewTelemetryFields(readings) {
  const packed = packTelemetry(buildTelemetrySensors(readings), readings.now);
  return new Map([[FIELD_TELEMETRY, packed]]);
}

test("an inbound crew telemetry snapshot populates Signal K when enabled", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  const identityHash = "7a3c9f1b2e4d58607a3c9f1b2e4d5860";
  const lxmfHash = deriveLxmfDestinationHash(identityHash);
  await plugin.start({
    messaging: {},
    telemetry: { populate_crew_telemetry: true },
    crew: [{ name: "Alice", identity: identityHash }],
  });
  const router = plugin.lxmf;

  router.dispatchEvent(
    new CustomEvent("message", {
      detail: {
        message: {
          sourceHash: Buffer.from(lxmfHash, "hex"),
          fields: crewTelemetryFields({
            latitude: 60.1,
            longitude: 21.1,
            batteryPercent: 80,
            now: 1700000000,
          }),
        },
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Exactly one crew-telemetry delta was published (plus any meta publishes).
  const crewDeltas = app.messages.filter(
    (m) =>
      m.delta.context &&
      m.delta.context === `vessels.urn:reticulum:identity:${identityHash}`,
  );
  assert.equal(crewDeltas.length, 1, "one crew telemetry delta published");
  const values = crewDeltas[0].delta.updates[0].values;
  const byPath = Object.fromEntries(
    values.filter((v) => v.path).map((v) => [v.path, v.value]),
  );
  assert.deepEqual(byPath["navigation.position"], {
    latitude: 60.1,
    longitude: 21.1,
  });
  assert.equal(
    byPath["electrical.batteries.7a3c9f1b.capacity.stateOfCharge"],
    0.8,
  );
  assert.equal(byPath["communication.reticulum.identityHash"], identityHash);

  await plugin.stop();
});

test("inbound crew telemetry is dropped when the setting is off", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  const identityHash = "7a3c9f1b2e4d58607a3c9f1b2e4d5860";
  const lxmfHash = deriveLxmfDestinationHash(identityHash);
  await plugin.start({
    messaging: {},
    telemetry: { populate_crew_telemetry: false },
    crew: [{ name: "Alice", identity: identityHash }],
  });
  const before = app.messages.length;
  plugin.lxmf.dispatchEvent(
    new CustomEvent("message", {
      detail: {
        message: {
          sourceHash: Buffer.from(lxmfHash, "hex"),
          fields: crewTelemetryFields({
            latitude: 1,
            longitude: 2,
            now: 1,
          }),
        },
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  // No new crew-telemetry deltas (only the startup meta, if any).
  assert.equal(app.messages.length, before);
  await plugin.stop();
});

test("inbound telemetry from a non-crew sender is dropped", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({
    messaging: {},
    telemetry: { populate_crew_telemetry: true },
    crew: [{ name: "Alice", identity: "7a3c9f1b2e4d58607a3c9f1b2e4d5860" }],
  });
  const before = app.messages.length;
  plugin.lxmf.dispatchEvent(
    new CustomEvent("message", {
      detail: {
        message: {
          // A source hash that does NOT match any configured crew member.
          sourceHash: new Uint8Array(16).fill(4),
          fields: crewTelemetryFields({ latitude: 1, longitude: 2, now: 1 }),
        },
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(app.messages.length, before, "no delta for a non-crew sender");
  await plugin.stop();
});

test("schema exposes an opt-in populate_crew_telemetry setting", () => {
  const group = makePlugin(makeApp()).schema().properties.telemetry;
  assert.equal(group.properties.populate_crew_telemetry.default, false);
  assert.equal(group.properties.enabled.default, false);
});

test("stop tears down messaging and the notification subscription", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({ messaging: {} });
  assert.ok(plugin.lxmf);

  await plugin.stop();

  assert.equal(plugin.lxmf, undefined);
  assert.equal(app.subscriptionmanager.unsubscribed, true);
});

// --- LXMF store-and-forward (propagation-node client) ---------------------

const PROP_NODE = "fedcba0987654321fedcba0987654321";

test("schema exposes an opt-in propagation configuration group", () => {
  const group = makePlugin(makeApp()).schema().properties.propagation;
  assert.equal(group.properties.enabled.default, false);
  assert.equal(group.properties.node.default, "");
  // The node hash is optional: empty (the default) auto-discovers the
  // closest propagation node, and a non-empty value must be a full hash.
  assert.equal(group.properties.node.pattern, "^([0-9a-fA-F]{32})?$");
  assert.ok(
    /auto-discover/.test(group.properties.node.description),
    "node description mentions auto-discovery",
  );
  assert.equal(group.properties.sync_interval_minutes.default, 5);
  assert.equal(group.properties.sync_interval_minutes.minimum, 1);
});

test("start does not configure a propagation node when disabled", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  await plugin.start({
    messaging: { display_name: "Boat" },
    propagation: { enabled: false, node: PROP_NODE },
  });

  assert.deepEqual(
    plugin.lxmf.propagationNodeCalls,
    [],
    "no outbound propagation node set when disabled",
  );
  await plugin.stop();
});

test("start falls back to propagation auto-discovery when the configured node hash is invalid", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  await plugin.start({
    messaging: { display_name: "Boat" },
    propagation: { enabled: true, node: "not-a-hash" },
  });

  // An invalid hash is treated like an empty one: nothing is configured yet,
  // and the closest propagation node is auto-discovered instead.
  assert.deepEqual(plugin.lxmf.propagationNodeCalls, []);
  assert.ok(
    app.debugCalls.some((args) =>
      /not a valid destination hash; falling back to auto-discovery/.test(
        args.join(" "),
      ),
    ),
  );
  assert.ok(
    app.debugCalls.some((args) =>
      /auto-discovering the closest lxmf\.propagation node/.test(
        args.join(" "),
      ),
    ),
  );
  await plugin.stop();
});

test("start configures the propagation node and schedules periodic syncs", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  const scheduled = [];
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn) => {
    scheduled.push({ kind: "timeout", fn });
    return 0;
  };
  globalThis.setInterval = (fn) => {
    scheduled.push({ kind: "interval", fn });
    return 0;
  };
  try {
    await plugin.start({
      messaging: { display_name: "Boat" },
      propagation: { enabled: true, node: PROP_NODE, sync_interval_minutes: 3 },
    });

    // The outbound propagation node is set on the router.
    assert.deepEqual(plugin.lxmf.propagationNodeCalls, [
      Buffer.from(PROP_NODE, "hex"),
    ]);
    assert.ok(
      app.debugCalls.some((args) =>
        /Configured LXMF propagation node/.test(args.join(" ")),
      ),
    );

    // A sync timer (initial + interval) is scheduled (plus the status timer).
    assert.ok(
      scheduled.filter((s) => s.kind === "timeout").length >= 1,
      "timers scheduled",
    );
    const intervals = scheduled.filter((s) => s.kind === "interval");
    assert.ok(intervals.length >= 1, "at least one interval scheduled");

    // Find the sync timeout by trying each one and checking which increments syncCalls.
    assert.equal(plugin.lxmf.syncCalls, 0);
    let foundSync = false;
    for (const s of scheduled.filter((t) => t.kind === "timeout")) {
      await s.fn();
      if (plugin.lxmf.syncCalls > 0) {
        foundSync = true;
        break;
      }
    }
    assert.ok(foundSync, "initial sync found and ran");
    assert.equal(plugin.lxmf.syncCalls, 1, "initial sync ran");

    // Find and fire the recurring sync interval (the one that increments syncCalls).
    let foundInterval = false;
    for (const s of intervals) {
      await s.fn();
      if (plugin.lxmf.syncCalls > 1) {
        foundInterval = true;
        break;
      }
    }
    assert.ok(foundInterval, "recurring sync found and ran");
    assert.equal(plugin.lxmf.syncCalls, 2, "recurring sync ran");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    await plugin.stop();
  }
});

test("start clamps the sync interval to a 1-minute minimum", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;

  const scheduled = [];
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  globalThis.setInterval = (fn, ms) => {
    scheduled.push({ fn, ms });
    return 0;
  };
  try {
    await plugin.start({
      messaging: { display_name: "Boat" },
      propagation: { enabled: true, node: PROP_NODE, sync_interval_minutes: 0 },
    });

    const interval = scheduled.find((o) => o && o.ms != null);
    assert.equal(interval.ms, 60 * 1000, "clamped to 1 minute");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    await plugin.stop();
  }
});

test("an alert to a reachable crew member is delivered directly (not via propagation)", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;
  const dest = "0123456789abcdef0123456789abcdef";

  await plugin.start({
    messaging: { send_alerts: true },
    crew: [{ name: "Alice", destination: dest }],
    propagation: { enabled: true, node: PROP_NODE },
  });
  const router = plugin.lxmf;

  app._onDelta({
    updates: [
      {
        values: [
          {
            path: "notifications.bilge",
            value: { state: "alarm", message: "Bilge!" },
          },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The recipient is reachable (FakeRns.hasPath defaults true), so the alert
  // goes out as a direct opportunistic send, not a propagation submit.
  assert.equal(router.sent.length, 1, "delivered directly");
  assert.equal(
    router.submitted.length,
    0,
    "not submitted to the propagation node",
  );

  await plugin.stop();
});

test("an alert to an unreachable crew member falls back to store-and-forward", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;
  const dest = "0123456789abcdef0123456789abcdef";

  await plugin.start({
    messaging: { send_alerts: true },
    crew: [{ name: "Alice", destination: dest }],
    propagation: { enabled: true, node: PROP_NODE },
  });
  const router = plugin.lxmf;
  // Mark the crew member's lxmf.delivery destination as unreachable.
  plugin.rns.transport._unreachable.add(dest);

  app._onDelta({
    updates: [
      {
        values: [
          {
            path: "notifications.bilge",
            value: { state: "alarm", message: "Bilge!" },
          },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // No known path -> the alert is submitted to the propagation node for
  // store-and-forward delivery, and no direct packet is emitted.
  assert.equal(router.sent.length, 0, "no direct send attempted");
  assert.equal(router.submitted.length, 1, "submitted to the propagation node");
  const { message } = router.submitted[0];
  assert.deepEqual(message.options.destinationHash, Buffer.from(dest, "hex"));
  assert.equal(message.options.title, "Signal K: bilge");
  assert.equal(message.options.content, "Bilge!");

  await plugin.stop();
});

test("alerts fall back to direct delivery when no propagation node is configured", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeLxmRouter.instances.length = 0;
  const dest = "0123456789abcdef0123456789abcdef";

  await plugin.start({
    messaging: { send_alerts: true },
    crew: [{ name: "Alice", destination: dest }],
  });
  const router = plugin.lxmf;

  app._onDelta({
    updates: [
      {
        values: [
          {
            path: "notifications.bilge",
            value: { state: "alarm", message: "Bilge!" },
          },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // No propagation node -> plain direct delivery, regardless of reachability.
  assert.equal(router.sent.length, 1);
  assert.equal(router.submitted.length, 0);

  await plugin.stop();
});

test("an announce from the configured propagation node is persisted", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({
    messaging: { display_name: "Boat" },
    propagation: { enabled: true, node: PROP_NODE },
  });
  const rns = plugin.rns;

  rns.transport.dispatchEvent(
    new CustomEvent("announce", {
      detail: {
        destinationHash: Buffer.from(PROP_NODE, "hex"),
        identity: { publicKey: new Uint8Array() },
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rns.persistor.storeCalls.length, 1);
  assert.deepEqual(
    rns.persistor.storeCalls[0].hash,
    Buffer.from(PROP_NODE, "hex"),
  );
  assert.ok(
    app.debugCalls.some((args) =>
      /Persisted propagation node/.test(args.join(" ")),
    ),
  );

  await plugin.stop();
});

test("propagation auto-discovers the closest node when none is configured", async () => {
  const realDiscover = makePlugin.deps.discoverClosestNode;
  let captured;
  makePlugin.deps.discoverClosestNode = (opts) => {
    captured = opts;
    return () => {};
  };
  try {
    const app = makeApp();
    const plugin = makePlugin(app);
    FakeLxmRouter.instances.length = 0;

    await plugin.start({
      messaging: { display_name: "Boat" },
      // Empty node -> auto-discovery path.
      propagation: { enabled: true, node: "" },
    });

    // Discovery is wired against the lxmf.propagation aspect name_hash.
    assert.ok(captured, "discoverClosestNode was called");
    assert.deepEqual(
      captured.nameHashesHex,
      aspectNameHashesHex([PROPAGATION_ASPECT]),
    );
    assert.equal(plugin.lxmf.propagationNodeCalls.length, 0);

    // A discovered propagation node is configured exactly like an explicit one.
    captured.onSelect(PROP_NODE, 1);
    assert.deepEqual(plugin.lxmf.propagationNodeCalls, [
      Buffer.from(PROP_NODE, "hex"),
    ]);
    assert.ok(
      app.debugCalls.some((args) =>
        /Auto-discovered LXMF propagation node/.test(args.join(" ")),
      ),
    );
    assert.ok(
      app.debugCalls.some((args) =>
        /Configured LXMF propagation node/.test(args.join(" ")),
      ),
    );

    await plugin.stop();
  } finally {
    makePlugin.deps.discoverClosestNode = realDiscover;
  }
});

test("propagation auto-discovery wires persistence for the discovered node", async () => {
  const realDiscover = makePlugin.deps.discoverClosestNode;
  let onSelect;
  makePlugin.deps.discoverClosestNode = (opts) => {
    onSelect = opts.onSelect;
    return () => {};
  };
  try {
    const app = makeApp();
    const plugin = makePlugin(app);
    await plugin.start({
      messaging: { display_name: "Boat" },
      propagation: { enabled: true, node: "" },
    });
    const rns = plugin.rns;

    // The discovered node's announce is persisted, same as an explicit node.
    onSelect(PROP_NODE, 2);
    rns.transport.dispatchEvent(
      new CustomEvent("announce", {
        detail: {
          destinationHash: Buffer.from(PROP_NODE, "hex"),
          identity: { publicKey: new Uint8Array() },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(
      app.debugCalls.some((args) =>
        /Persisted propagation node/.test(args.join(" ")),
      ),
    );
    await plugin.stop();
  } finally {
    makePlugin.deps.discoverClosestNode = realDiscover;
  }
});

// --- Telemetry broadcast (opt-in) ----------------------------------------

test("schema exposes an opt-in telemetry broadcast configuration group", () => {
  const group = makePlugin(makeApp()).schema().properties.telemetry;
  assert.equal(group.properties.enabled.default, false);
  assert.equal(group.properties.interval_seconds.default, 300);
  assert.equal(group.properties.interval_seconds.minimum, 30);
});

test("start does not schedule telemetry when the option is disabled", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  const scheduled = [];
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  globalThis.setInterval = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  try {
    await plugin.start({
      messaging: { display_name: "Boat" },
      crew: [
        { name: "Alice", destination: "0123456789abcdef0123456789abcdef" },
      ],
    });
    // Status timer is always scheduled, but no telemetry timer.
    assert.ok(scheduled.length >= 2, "status timers scheduled (no telemetry)");
    // Verify none of the scheduled timers send telemetry messages.
    for (const fn of scheduled) {
      await fn();
    }
    assert.ok(
      !plugin.lxmf || plugin.lxmf.sent.length === 0,
      "no telemetry messages sent",
    );
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    await plugin.stop();
  }
});

test("start schedules and fires a telemetry broadcast to the crew when enabled", async () => {
  const app = makeApp();
  app.getSelfPath = (p) =>
    p === "navigation.position" ? { latitude: 1, longitude: 2 } : undefined;
  const plugin = makePlugin(app);
  const dest = "0123456789abcdef0123456789abcdef";

  // Capture the scheduled timers without firing them, so the test stays
  // deterministic (no real 5 s / interval waits).
  const scheduled = [];
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  globalThis.setInterval = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  try {
    await plugin.start({
      messaging: { display_name: "Boat" },
      telemetry: { enabled: true, interval_seconds: 30 },
      crew: [{ name: "Alice", destination: dest }],
    });

    const router = plugin.lxmf;
    assert.equal(router.sent.length, 0, "nothing sent before the timer fires");
    assert.ok(scheduled.length >= 1, "a telemetry timer was scheduled");

    // Find and fire the telemetry callback (the one that sends a message).
    for (const fn of scheduled) {
      await fn();
      if (router.sent.length > 0) {
        break;
      }
    }

    assert.equal(router.sent.length, 1, "one telemetry snapshot sent");
    const fields = router.sent[0].message.options.fields;
    assert.ok(fields instanceof Map, "telemetry carried in LXMF fields map");
    const packed = fields.get(0x02);
    assert.ok(
      packed instanceof Uint8Array,
      "FIELD_TELEMETRY holds packed bytes",
    );
    assert.deepEqual(
      router.sent[0].message.options.destinationHash,
      Buffer.from(dest, "hex"),
    );
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    await plugin.stop();
  }
});

test("telemetry broadcast carries the derived appearance (icon + colors)", async () => {
  const app = makeApp();
  app.getSelfPath = (p) => {
    if (p === "navigation.position") return { latitude: 1, longitude: 2 };
    // AIS ship type 36 = Sailing.
    if (p === "design.aisShipType")
      return { value: { id: 36, name: "Sailing" } };
    return undefined;
  };
  const plugin = makePlugin(app);
  const dest = "0123456789abcdef0123456789abcdef";

  const scheduled = [];
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  globalThis.setInterval = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  try {
    await plugin.start({
      telemetry: { enabled: true, interval_seconds: 30 },
      appearance: { icon: "", fg_color: "#ffffff", bg_color: "#1a237e" },
      crew: [{ name: "Alice", destination: dest }],
    });

    // Find and fire the telemetry callback.
    for (const fn of scheduled) {
      await fn();
      if (plugin.lxmf.sent.length > 0) {
        break;
      }
    }

    const fields = plugin.lxmf.sent[0].message.options.fields;
    const appearance = fields.get(0x04);
    assert.ok(appearance, "FIELD_ICON_APPEARANCE present on the wire");
    // Sailing vessel (AIS 36) with no explicit icon -> sail-boat.
    assert.equal(appearance[0], "sail-boat");
    // Colors are 3-byte bin payloads (Uint8Array), not int arrays.
    assert.ok(appearance[1] instanceof Uint8Array, "fg is a byte string");
    assert.ok(appearance[2] instanceof Uint8Array, "bg is a byte string");
    assert.deepEqual(Array.from(appearance[1]), [255, 255, 255]);
    assert.deepEqual(Array.from(appearance[2]), [26, 35, 126]);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    await plugin.stop();
  }
});

test("telemetry broadcast uses the ferry icon for a motor vessel", async () => {
  const app = makeApp();
  app.getSelfPath = (p) => {
    if (p === "navigation.position") return { latitude: 1, longitude: 2 };
    // AIS ship type 37 = Pleasure craft (motor).
    if (p === "design.aisShipType")
      return { value: { id: 37, name: "Pleasure" } };
    return undefined;
  };
  const plugin = makePlugin(app);
  const dest = "0123456789abcdef0123456789abcdef";

  const scheduled = [];
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  globalThis.setInterval = (fn) => {
    scheduled.push(fn);
    return 0;
  };
  try {
    await plugin.start({
      telemetry: { enabled: true, interval_seconds: 30 },
      crew: [{ name: "Alice", destination: dest }],
    });

    // Find and fire the telemetry callback.
    for (const fn of scheduled) {
      await fn();
      if (plugin.lxmf.sent.length > 0) {
        break;
      }
    }

    const fields = plugin.lxmf.sent[0].message.options.fields;
    assert.equal(fields.get(0x04)[0], "ferry");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    await plugin.stop();
  }
});

test("telemetry broadcasts stop when the plugin is stopped", async () => {
  const app = makeApp();
  app.getSelfPath = () => ({ latitude: 1, longitude: 2 });
  const plugin = makePlugin(app);
  let clearedTimeout = false;
  let clearedInterval = false;
  const origSetTimeout = globalThis.setTimeout;
  const origSetInterval = globalThis.setInterval;
  const origClearTimeout = globalThis.clearTimeout;
  const origClearInterval = globalThis.clearInterval;
  globalThis.setTimeout = (fn) => fn;
  globalThis.setInterval = (fn) => fn;
  globalThis.clearTimeout = () => {
    clearedTimeout = true;
  };
  globalThis.clearInterval = () => {
    clearedInterval = true;
  };
  try {
    await plugin.start({
      messaging: {},
      telemetry: { enabled: true, interval_seconds: 30 },
      crew: [
        { name: "Alice", destination: "0123456789abcdef0123456789abcdef" },
      ],
    });
    await plugin.stop();
    assert.ok(clearedTimeout, "initial telemetry timer cleared on stop");
    assert.ok(clearedInterval, "telemetry interval cleared on stop");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.setInterval = origSetInterval;
    globalThis.clearTimeout = origClearTimeout;
    globalThis.clearInterval = origClearInterval;
  }
});

// --- NomadNet site (opt-in) -----------------------------------------------

test("schema exposes an opt-in NomadNet configuration group", () => {
  const plugin = makePlugin(makeApp());
  const group = plugin.schema().properties.nomadnet;

  assert.equal(group.properties.enabled.default, false);
  assert.equal(group.properties.display_name.default, "");
  assert.equal(group.properties.banner.default, "");
  assert.equal(group.properties.banner.type, "string");
  assert.equal(group.properties.banner.format, "textarea");
  assert.equal(group.properties.footer.default, "");
  assert.equal(group.properties.footer.type, "string");
  assert.equal(group.properties.footer.format, "textarea");
});

test("start does not bring up the NomadNet site when disabled", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeNomadDestination.instances.length = 0;

  await plugin.start({});

  assert.equal(plugin.nomadnet, undefined);
  assert.equal(
    FakeNomadDestination.instances.length,
    0,
    "no destination created",
  );
});

test("start brings up the NomadNet site, announces and serves the index page", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeNomadDestination.instances.length = 0;

  await plugin.start({ nomadnet: { enabled: true } });

  assert.ok(plugin.nomadnet, "site handle exposed");
  assert.equal(
    FakeNomadDestination.instances.length,
    1,
    "one node destination",
  );
  const dest = FakeNomadDestination.instances[0];
  assert.equal(dest.name, "nomadnetwork.node");
  assert.deepEqual(
    plugin.rns.registeredDestinations,
    [dest],
    "destination registered with the node",
  );
  assert.deepEqual(
    dest.registered.map((r) => r.path),
    ["/page/index.mu"],
  );
  assert.equal(dest.announceCalls, 0, "no one-shot announce");
  // Re-announce is on by default, so the node is announced via the periodic
  // loop (which fires the first announce immediately).
  assert.deepEqual(dest.startAnnouncingCalls, [{ intervalMs: 30 * 60 * 1000 }]);
});

test("the served index page shows the vessel name", async () => {
  const app = makeApp();
  app.getSelfPath = (path) =>
    path === "name" ? { value: "S/Y Bergie" } : undefined;
  const plugin = makePlugin(app);
  FakeNomadDestination.instances.length = 0;

  await plugin.start({ nomadnet: { enabled: true } });

  const dest = FakeNomadDestination.instances[0];
  const page = await dest.registered[0].options.responseGenerator();
  assert.deepEqual(Buffer.from(page).toString("utf8"), ">>S/Y Bergie\n");
});

test("the served index page includes live telemetry from Signal K", async () => {
  const app = makeApp();
  const paths = {
    name: { value: "S/Y Bergie" },
    "navigation.state": { value: "anchored" },
    "navigation.position": { value: { latitude: 60.1234, longitude: 21.5678 } },
    "navigation.anchor.distanceFromBow": { value: 12.3 },
    "environment.depth.belowSurface": { value: 5.2 },
    "environment.tide.heightNow": { value: 1.3 },
    "environment.tide.state": { value: "rising" },
    "environment.wind.speedOverGround": { value: 6.0 },
    "environment.wind.directionTrue": { value: Math.PI / 4 },
    "electrical.batteries.house.capacity.stateOfCharge": { value: 0.87 },
    "electrical.batteries.house.current": { value: 2.3 },
  };
  app.getSelfPath = (path) => paths[path];
  const plugin = makePlugin(app);
  FakeNomadDestination.instances.length = 0;

  await plugin.start({ nomadnet: { enabled: true } });

  const dest = FakeNomadDestination.instances[0];
  const page = await dest.registered[0].options.responseGenerator();
  const text = Buffer.from(page).toString("utf8");
  assert.match(text, />>S\/Y Bergie/);
  assert.match(text, />Vessel status/);
  assert.match(text, /Vessel is anchored/);
  assert.match(text, /Position: 60\u00B007.404' N, 021\u00B034.068' E/);
  assert.match(text, /Anchor: 12.3 m from bow/);
  assert.match(text, /Depth: 5.2 m below surface/);
  assert.match(text, /Tide: 1.3 m, rising/);
  assert.match(text, /Wind: 12 kn from 45\u00B0/);
  assert.match(text, /Battery: 87 %, 2.3 A/);
});

test("the served index page uses the configured banner when set", async () => {
  const app = makeApp();
  app.getSelfPath = (path) =>
    path === "name" ? { value: "S/Y Bergie" } : undefined;
  const plugin = makePlugin(app);
  FakeNomadDestination.instances.length = 0;

  await plugin.start({ nomadnet: { enabled: true, banner: "/|__\n\\__/" } });

  const dest = FakeNomadDestination.instances[0];
  const page = await dest.registered[0].options.responseGenerator();
  const text = Buffer.from(page).toString("utf8");
  assert.ok(text.startsWith("/|__\n\\__/"), "banner shown at the top");
  assert.doesNotMatch(text, /S\/Y Bergie/);
});

test("the served index page appends the configured footer", async () => {
  const app = makeApp();
  app.getSelfPath = (path) =>
    path === "name" ? { value: "S/Y Bergie" } : undefined;
  const plugin = makePlugin(app);
  FakeNomadDestination.instances.length = 0;

  await plugin.start({
    nomadnet: { enabled: true, footer: "73 de OH7B" },
  });

  const dest = FakeNomadDestination.instances[0];
  const page = await dest.registered[0].options.responseGenerator();
  const text = Buffer.from(page).toString("utf8");
  assert.equal(
    text,
    ">>S/Y Bergie\n\n73 de OH7B\n",
    "footer shown at the bottom",
  );
});

test("stop deregisters the NomadNet site", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  FakeNomadDestination.instances.length = 0;
  await plugin.start({ nomadnet: { enabled: true } });
  const dest = FakeNomadDestination.instances[0];
  const rns = plugin.rns;

  await plugin.stop();

  assert.deepEqual(dest.removed, ["/page/index.mu"], "page handler removed");
  assert.deepEqual(
    rns.deregisteredDestinations,
    [dest],
    "destination deregistered",
  );
  assert.equal(plugin.nomadnet, undefined);
});

test("start uses a shared Reticulum instance when one is available", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  sharedState.calls = 0;
  sharedState.available = true;

  try {
    await plugin.start({});

    assert.equal(sharedState.calls, 1, "shared-instance connector attempted");
    assert.equal(plugin.interfaces.length, 1);
    assert.equal(plugin.interfaces[0].name, "shared-instance");
    // The shared interface returned by the factory is attached to the node.
    assert.equal(plugin.rns.added.length, 1);
    assert.match(app.statusCalls[0], /connected to shared Reticulum instance/);
  } finally {
    sharedState.available = false;
  }
});

test("start falls back to configured interfaces when no shared instance is reachable", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  sharedState.available = false;

  await plugin.start({});

  assert.equal(plugin.interfaces.length, 1);
  assert.equal(plugin.interfaces[0].type, "auto");
  assert.match(app.statusCalls[0], /1 interface\(s\) connected/);
});

test("start does not attempt the shared instance when use_shared_instance is false", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  sharedState.calls = 0;
  sharedState.available = true;

  try {
    await plugin.start({ use_shared_instance: false });

    assert.equal(sharedState.calls, 0, "shared instance not attempted");
    assert.equal(plugin.interfaces[0].type, "auto");
    assert.match(app.statusCalls[0], /1 interface\(s\) connected/);
  } finally {
    sharedState.available = false;
  }
});

// --- Filesystem storage adapter & crew persistence --------------------------

test("start wires a filesystem storage adapter into the Reticulum node when a data dir is available", async () => {
  const app = makeAppWithDataDir();
  const plugin = makePlugin(app);
  await plugin.start({});

  const adapter = plugin.rns.config.storageAdapter;
  assert.ok(
    adapter instanceof FileStorageAdapter,
    "FileStorageAdapter wired in",
  );
  assert.equal(adapter.directory, app.getDataDirPath());
  assert.ok(
    app.debugCalls.some((args) =>
      /Persisting Reticulum data/.test(args.join(" ")),
    ),
  );
});

test("persistence is disabled when the server exposes no data directory", async () => {
  const app = makeApp(); // no getDataDirPath
  const plugin = makePlugin(app);
  await plugin.start({});

  assert.equal(plugin.rns.config.storageAdapter, null);
  assert.ok(
    app.debugCalls.some((args) => /persistence disabled/i.test(args.join(" "))),
  );
});

test("an announce from a configured crew member is persisted pre-emptively", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  const dest = "0123456789abcdef0123456789abcdef";
  await plugin.start({ crew: [{ name: "Alice", destination: dest }] });
  const rns = plugin.rns;

  rns.transport.dispatchEvent(
    new CustomEvent("announce", {
      detail: {
        destinationHash: Buffer.from(dest, "hex"),
        identity: { publicKey: new Uint8Array() },
      },
    }),
  );
  // The persistor call is async; let it flush.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rns.persistor.storeCalls.length, 1);
  const call = rns.persistor.storeCalls[0];
  assert.deepEqual(call.hash, Buffer.from(dest, "hex"));
  assert.ok(call.opts.announce, "announce detail forwarded to the persistor");
});

test("announces from non-crew destinations are not persisted", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({
    crew: [{ name: "Alice", destination: "0123456789abcdef0123456789abcdef" }],
  });
  const rns = plugin.rns;

  rns.transport.dispatchEvent(
    new CustomEvent("announce", {
      detail: {
        destinationHash: Buffer.from("fedcba9876543210fedcba9876543210", "hex"),
        identity: { publicKey: new Uint8Array() },
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0);
});

test("crew persistence stops after the plugin is stopped", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  const dest = "0123456789abcdef0123456789abcdef";
  await plugin.start({ crew: [{ name: "Alice", destination: dest }] });
  const rns = plugin.rns;

  await plugin.stop();

  rns.transport.dispatchEvent(
    new CustomEvent("announce", {
      detail: { destinationHash: Buffer.from(dest, "hex"), identity: {} },
    }),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rns.persistor.storeCalls.length, 0, "listener removed on stop");
});

test("stop flushes the persistence layer", async () => {
  const app = makeApp();
  const plugin = makePlugin(app);
  await plugin.start({});
  const rns = plugin.rns;
  assert.equal(rns.persistor.flushCalls, 0);

  await plugin.stop();

  assert.equal(rns.persistor.flushCalls, 1);
});

// --- RFed ship-to-ship telemetry -------------------------------------------

/** A destination hash used across the RFed integration tests. */
const RFED_NODE = "cd".repeat(16);

/**
 * A minimal RFedClient fake: records listen/subscribe/publish calls and lets a
 * test deliver a decoded fanout message to the onMessage callback handed to
 * `listen`. The constructor signature mirrors the real client.
 */
class FakeRFedClient {
  constructor({ identity, rns }) {
    this.identity = identity;
    this.rns = rns;
    FakeRFedClient.instances.push(this);
  }
  async listen(onMessage) {
    this.onMessage = onMessage;
    this.listenCalls = (this.listenCalls || 0) + 1;
    return Buffer.from("11".repeat(16), "hex");
  }
  async subscribe(nodeHash, channel) {
    this.subscribeCalls = this.subscribeCalls || [];
    this.subscribeCalls.push({ nodeHash, channel });
    return { ok: true, stampCost: 0 };
  }
  async publish(nodeHash, channel, message) {
    this.publishCalls = this.publishCalls || [];
    this.publishCalls.push({ nodeHash, channel, message });
  }
}
FakeRFedClient.instances = [];

/** Replaces (and restores) the RFedClient class used by the rfed module. */
function withFakeRFedClient(fn) {
  return async () => {
    const real = rfed.deps.RFedClient;
    FakeRFedClient.instances.length = 0;
    rfed.deps.RFedClient = FakeRFedClient;
    try {
      await fn();
    } finally {
      rfed.deps.RFedClient = real;
    }
  };
}

test("schema exposes an opt-in rfed configuration group", () => {
  const group = makePlugin(makeApp()).schema().properties.rfed;
  assert.ok(group);
  assert.equal(group.properties.enabled.default, false);
  assert.equal(group.properties.transmit_telemetry.default, false);
  assert.equal(group.properties.receive_telemetry.default, false);
  assert.equal(group.properties.channel.default, "public.signalk.vessels");
  assert.equal(group.properties.interval_seconds.default, 300);
  // The node hash is optional: empty (the default) auto-discovers the
  // closest rfed federation node, and a non-empty value must be a full hash.
  assert.equal(group.properties.node.pattern, "^([0-9a-fA-F]{32})?$");
  assert.ok(
    /auto-discover/.test(group.properties.node.description),
    "node description mentions auto-discovery",
  );
  assert.equal(group.additionalProperties, false);
});

test(
  "start brings up the RFed client when enabled with a valid node",
  withFakeRFedClient(async () => {
    const app = makeApp();
    const plugin = makePlugin(app);
    await plugin.start({
      messaging: { display_name: "Boat" },
      rfed: {
        enabled: true,
        node: RFED_NODE,
        channel: "public.signalk.vessels",
        transmit_telemetry: false,
        receive_telemetry: true,
      },
    });
    assert.equal(FakeRFedClient.instances.length, 1);
    const client = FakeRFedClient.instances[0];
    assert.equal(client.listenCalls, 1);
    assert.ok(client.subscribeCalls.length >= 1);
    assert.equal(client.subscribeCalls[0].channel, "public.signalk.vessels");
    assert.ok(
      app.debugCalls.some((args) =>
        /Announced rfed\.delivery destination/.test(args.join(" ")),
      ),
    );
    await plugin.stop();
  }),
);

test(
  "start falls back to RFed auto-discovery when the configured node hash is invalid",
  withFakeRFedClient(async () => {
    const app = makeApp();
    const plugin = makePlugin(app);
    await plugin.start({
      rfed: { enabled: true, node: "not-a-hash" },
    });
    // An invalid hash is treated like an empty one: nothing is brought up
    // yet, and the closest federation node is auto-discovered instead.
    assert.equal(FakeRFedClient.instances.length, 0);
    assert.ok(
      app.debugCalls.some((args) =>
        /not a valid destination hash; falling back to auto-discovery/.test(
          args.join(" "),
        ),
      ),
    );
    assert.ok(
      app.debugCalls.some((args) =>
        /auto-discovering the closest rfed federation node/.test(
          args.join(" "),
        ),
      ),
    );
    await plugin.stop();
  }),
);

test(
  "start publishes own telemetry to the channel when transmit is enabled",
  withFakeRFedClient(async () => {
    const app = makeApp();
    // Give the boat some data to broadcast.
    app.getSelfPath = (path) => {
      if (path === "name") return "Meri Imperiumi";
      if (path === "mmsi") return "230001234";
      if (path === "navigation.position")
        return { value: { latitude: 60.1, longitude: 21.1 } };
      if (path === "navigation.speedOverGround") return { value: 5 };
      return undefined;
    };
    const plugin = makePlugin(app);

    // Capture timers so the initial publish (a 5s timeout) can be driven
    // without actually waiting.
    const timeouts = [];
    const origSetTimeout = globalThis.setTimeout;
    const origSetInterval = globalThis.setInterval;
    globalThis.setTimeout = (fn, ms) => {
      timeouts.push({ fn, ms });
      return 0;
    };
    globalThis.setInterval = (fn, ms) => {
      timeouts.push({ fn, ms, interval: true });
      return 0;
    };
    try {
      await plugin.start({
        messaging: { display_name: "Boat" },
        rfed: {
          enabled: true,
          node: RFED_NODE,
          transmit_telemetry: true,
          receive_telemetry: false,
          interval_seconds: 300,
        },
      });
      const client = plugin.rfed;
      assert.ok(client, "rfed client brought up");
      // Fire the initial publish timeout (5s) manually.
      await Promise.all(
        timeouts.filter((t) => !t.interval && t.ms === 5000).map((t) => t.fn()),
      );
      assert.ok(
        client.publishCalls && client.publishCalls.length >= 1,
        "at least one snapshot published",
      );
      const { nodeHash, channel, message } = client.publishCalls[0];
      assert.deepEqual([...nodeHash], [...Buffer.from(RFED_NODE, "hex")]);
      assert.equal(channel, "public.signalk.vessels");
      assert.ok(message.fields instanceof Map);
      assert.ok(message.fields.has(FIELD_TELEMETRY));
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.setInterval = origSetInterval;
      await plugin.stop();
    }
  }),
);

test(
  "received RFed telemetry populates Signal K under the sender's MMSI context",
  withFakeRFedClient(async () => {
    const app = makeApp();
    const plugin = makePlugin(app);
    await plugin.start({
      messaging: { display_name: "Boat" },
      rfed: {
        enabled: true,
        node: RFED_NODE,
        transmit_telemetry: false,
        receive_telemetry: true,
      },
    });
    const client = plugin.rfed;
    assert.ok(client, "rfed client brought up");
    // Build a foreign vessel snapshot and deliver it as a fanout message.
    const { Identity } = require("@reticulum/core");
    const { encodeShipTelemetry } = rfed;
    const sender = await Identity.generate();
    const packed = encodeShipTelemetry({
      now: Math.floor(Date.now() / 1000),
      name: "Other Boat",
      mmsi: "230009999",
      latitude: 59.9,
      longitude: 20.5,
      sog: 3,
    });
    client.onMessage({
      message: {
        timestamp: Math.floor(Date.now() / 1000),
        fields: new Map([[FIELD_TELEMETRY, packed]]),
      },
      senderIdentity: sender,
      sourceHash: Buffer.from("ff".repeat(16), "hex"),
      signatureValid: true,
    });
    assert.ok(
      app.messages.some(
        (m) =>
          m.id === "signalk-reticulum" &&
          m.delta.context === "vessels.urn:mrn:imo:mmsi:230009999",
      ),
      "telemetry populated under the sender's MMSI context",
    );
    await plugin.stop();
  }),
);

test(
  "start does not bring up RFed when disabled",
  withFakeRFedClient(async () => {
    const app = makeApp();
    const plugin = makePlugin(app);
    await plugin.start({ rfed: { enabled: false, node: RFED_NODE } });
    assert.equal(FakeRFedClient.instances.length, 0);
    await plugin.stop();
  }),
);

test(
  "RFed auto-discovers the closest federation node when none is configured",
  withFakeRFedClient(async () => {
    const realDiscover = makePlugin.deps.discoverClosestNode;
    let captured;
    makePlugin.deps.discoverClosestNode = (opts) => {
      captured = opts;
      return () => {};
    };
    try {
      const app = makeApp();
      const plugin = makePlugin(app);
      await plugin.start({
        messaging: { display_name: "Boat" },
        // Empty node -> auto-discovery path.
        rfed: { enabled: true, node: "", receive_telemetry: true },
      });

      // Discovery matches the rfed federation-node server aspects and excludes
      // the client-only rfed.delivery.
      assert.ok(captured, "discoverClosestNode was called");
      assert.deepEqual(
        captured.nameHashesHex.slice().sort(),
        aspectNameHashesHex(RFED_NODE_ASPECTS).slice().sort(),
      );
      assert.equal(FakeRFedClient.instances.length, 0);

      // A discovered node brings up the client exactly like an explicit one.
      await captured.onSelect(RFED_NODE, 1);
      assert.equal(FakeRFedClient.instances.length, 1);
      const client = FakeRFedClient.instances[0];
      assert.equal(client.listenCalls, 1);
      assert.ok(client.subscribeCalls.length >= 1);
      assert.ok(
        app.debugCalls.some((args) =>
          /Auto-discovered RFed federation node/.test(args.join(" ")),
        ),
      );
      await plugin.stop();
    } finally {
      makePlugin.deps.discoverClosestNode = realDiscover;
    }
  }),
);
