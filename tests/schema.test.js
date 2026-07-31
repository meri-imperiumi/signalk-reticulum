const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPluginSchema,
  buildInterfaceArray,
  buildInterfaceArrays,
  configKeyFor,
  EXCLUDED_INTERFACE_IDS,
} = require("../plugin/schema");

/**
 * @param {Partial<{id:string,name:string,schema:object}>} [overrides]
 * @returns {{id:string,name:string,schema:object}}
 */
function makeEntry(overrides = {}) {
  return {
    id: "fake",
    name: "Fake Interface",
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: "Fake Interface",
      description: "A fake interface for testing.",
      properties: {
        name: { type: "string" },
        host: { type: "string" },
      },
      required: ["host"],
      additionalProperties: false,
    },
    ...overrides,
  };
}

test("configKeyFor pluralises client/server ids and suffixes the rest", () => {
  assert.equal(configKeyFor("tcp-client"), "tcp_clients");
  assert.equal(configKeyFor("tcp-server"), "tcp_servers");
  assert.equal(configKeyFor("http-client"), "http_clients");
  assert.equal(configKeyFor("local-client"), "local_clients");
  assert.equal(configKeyFor("ws-client"), "ws_clients");
  assert.equal(configKeyFor("auto"), "auto_interfaces");
  assert.equal(configKeyFor("webrtc"), "webrtc_interfaces");
});

test("EXCLUDED_INTERFACE_IDS hides the browser-only WebRTC interface", () => {
  assert.ok(EXCLUDED_INTERFACE_IDS.includes("webrtc"));
});

test("buildInterfaceArray wraps one type's options as a plain instance array", () => {
  const array = buildInterfaceArray(makeEntry({ name: "Fake Interface" }));

  assert.equal(array.type, "array");
  // The array title is the interface name pluralised.
  assert.equal(array.title, "Fake Interfaces");
  assert.equal(array.items.type, "object");
  assert.equal(array.items.title, "Fake Interface");
  assert.equal(array.items.description, "A fake interface for testing.");
  assert.equal(array.items.additionalProperties, false);
  assert.deepEqual(array.items.required, ["host"]);
  assert.ok("host" in array.items.properties);
  assert.ok("name" in array.items.properties);
});

test("buildInterfaceArray appends -es when the interface name ends in s", () => {
  const array = buildInterfaceArray(makeEntry({ name: "Bus" }));
  assert.equal(array.title, "Buses");
});

test("buildInterfaceArray omits items.description when the schema has none", () => {
  const array = buildInterfaceArray({
    id: "bare",
    name: "Bare",
    schema: { properties: {}, required: [] },
  });
  assert.equal("description" in array.items, false);
});

test("buildInterfaceArray omits items.additionalProperties when the schema has none", () => {
  const array = buildInterfaceArray({
    id: "loose",
    name: "Loose",
    schema: { properties: { host: { type: "string" } } },
  });
  assert.equal("additionalProperties" in array.items, false);
});

test("buildInterfaceArrays exposes one array per interface except the excluded ones", () => {
  const arrays = buildInterfaceArrays([
    makeEntry({ id: "auto", name: "AutoInterface" }),
    makeEntry({ id: "tcp-client", name: "TCP Client Interface" }),
    makeEntry({ id: "webrtc", name: "WebRTC Interface" }),
  ]);

  assert.deepEqual(Object.keys(arrays).sort(), [
    "auto_interfaces",
    "tcp_clients",
  ]);
  assert.ok(!("webrtc_interfaces" in arrays));
});

test("buildPluginSchema returns a draft-07 object schema", () => {
  const schema = buildPluginSchema([]);

  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.type, "object");
  assert.equal(schema.title, "Signal K Reticulum");
});

test("buildPluginSchema places one instance array per non-excluded interface between use_shared_instance and identity", () => {
  const entries = [
    makeEntry({ id: "auto", name: "AutoInterface" }),
    makeEntry({ id: "tcp-client", name: "TCP Client Interface" }),
    makeEntry({ id: "webrtc", name: "WebRTC Interface" }),
  ];
  const schema = buildPluginSchema(entries);
  const keys = Object.keys(schema.properties);

  // Non-interface groups bookend the interface arrays.
  assert.equal(keys[0], "log_level");
  assert.equal(keys[1], "use_shared_instance");
  assert.equal(keys[keys.length - 1], "appearance");

  // The interface arrays land between use_shared_instance and the announce
  // group, in registry order, excluding WebRTC.
  const ifaceKeys = keys.slice(2, keys.indexOf("announce"));
  assert.deepEqual(ifaceKeys, ["auto_interfaces", "tcp_clients"]);

  // Each array carries its interface's required fields.
  assert.deepEqual(
    schema.properties.tcp_clients.items.required,
    entries[1].schema.required,
  );
});

test("buildPluginSchema never exposes a WebRTC config array", () => {
  const schema = buildPluginSchema([makeEntry({ id: "webrtc" })]);
  assert.ok(!("webrtc_interfaces" in schema.properties));
});

test("buildPluginSchema exposes an appearance group with icon + hex colors", () => {
  const schema = buildPluginSchema([]);
  const appearance = schema.properties.appearance;

  assert.equal(appearance.type, "object");
  assert.equal(appearance.additionalProperties, false);
  assert.deepEqual(Object.keys(appearance.properties), [
    "icon",
    "fg_color",
    "bg_color",
  ]);

  // The icon defaults to empty so it is derived from the AIS ship type.
  assert.equal(appearance.properties.icon.type, "string");
  assert.equal(appearance.properties.icon.default, "");

  // Colors default to nautical indigo on white and use the `color` format so
  // the Signal K config UI renders a colour picker.
  assert.equal(appearance.properties.fg_color.default, "#ffffff");
  assert.equal(appearance.properties.bg_color.default, "#1a237e");
  assert.equal(appearance.properties.fg_color.format, "color");
  assert.equal(appearance.properties.bg_color.format, "color");
});

test("buildPluginSchema exposes an announce group with a 30-minute default", () => {
  const schema = buildPluginSchema([]);
  const announce = schema.properties.announce;

  assert.equal(announce.type, "object");
  assert.equal(announce.additionalProperties, false);
  assert.deepEqual(Object.keys(announce.properties), [
    "reannounce_interval_minutes",
    "connectivity_paths",
  ]);

  const interval = announce.properties.reannounce_interval_minutes;
  assert.equal(interval.type, "number");
  // 30-minute default matches Reticulum's own DEFAULT_ANNOUNCE_INTERVAL_MS.
  assert.equal(interval.default, 30);
  // 0 disables re-announcing (one-shot announce only); any value is allowed
  // from 0 up — Reticulum clamps sub-minute values itself.
  assert.equal(interval.minimum, 0);

  // The connectivity-change trigger defaults to the Starlink and LTE paths
  // and is an array so more providers can be added.
  const paths = announce.properties.connectivity_paths;
  assert.equal(paths.type, "array");
  assert.deepEqual(paths.default, [
    "network.providers.starlink.status",
    "networking.lte.registerNetworkDisplay",
  ]);
  assert.equal(paths.items.type, "string");
});
