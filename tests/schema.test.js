const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPluginSchema,
  buildPluginUiSchema,
  buildInterfaceArray,
  buildInterfaceArrays,
  configKeyFor,
  EXCLUDED_INTERFACE_IDS,
  ADVANCED_GROUPS,
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
  assert.equal(keys[keys.length - 1], "embedded_nodes");

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

test("buildPluginSchema crew items support both identity and destination", () => {
  const schema = buildPluginSchema([]);
  const crew = schema.properties.crew;

  assert.equal(crew.type, "array");
  assert.deepEqual(crew.default, []);

  // Only name is required (identity is optional for legacy config support)
  assert.deepEqual(crew.items.required, ["name"]);

  // Both identity and destination are valid properties
  assert.ok("name" in crew.items.properties);
  assert.ok("identity" in crew.items.properties);
  assert.ok("destination" in crew.items.properties);

  // No additional properties allowed
  assert.equal(crew.items.additionalProperties, false);

  // Both identity and destination use the same 32-char hex pattern
  const identity = crew.items.properties.identity;
  const destination = crew.items.properties.destination;

  assert.equal(identity.type, "string");
  assert.equal(identity.pattern, "^[0-9a-fA-F]{32}$");
  assert.equal(identity.minLength, 32);
  assert.equal(identity.maxLength, 32);

  assert.equal(destination.type, "string");
  assert.equal(destination.pattern, "^[0-9a-fA-F]{32}$");
  assert.equal(destination.minLength, 32);
  assert.equal(destination.maxLength, 32);

  // Destination is marked as legacy
  assert(destination.title.includes("legacy"));
});

/**
 * Builds an interface registry entry shaped like a real one, for uiSchema
 * tests.
 *
 * @param {Partial<{id:string,name:string,schema:object}>} [overrides]
 * @returns {{id:string,name:string,schema:object}}
 */
function makeUiEntry(overrides = {}) {
  return {
    id: "fake",
    name: "Fake Interface",
    schema: { properties: { host: { type: "string" } }, required: ["host"] },
    ...overrides,
  };
}

/**
 * The expected uiSchema fragment for hiding a field via the built-in RJSF
 * `hidden` widget (which the Signal K admin UI supports natively, unlike the
 * `collapsible` field from react-jsonschema-form-extras).
 */
const HIDDEN = { "ui:widget": "hidden" };

test("buildPluginUiSchema surfaces the essentials first and the log level last", () => {
  const entries = [
    makeUiEntry({ id: "auto", name: "AutoInterface" }),
    makeUiEntry({ id: "tcp-client", name: "TCP Client Interface" }),
    makeUiEntry({ id: "webrtc", name: "WebRTC Interface" }),
  ];
  const ui = buildPluginUiSchema(entries);
  const order = ui["ui:order"];

  // The shared-instance switch and the crew-alerting setup lead, so a casual
  // user sees the basics before the advanced groups and the interface arrays.
  assert.deepEqual(order.slice(0, 4), [
    "use_shared_instance",
    "messaging",
    "crew",
    "identity",
  ]);
  // The log level — a troubleshooting knob — is always dead last.
  assert.equal(order[order.length - 1], "log_level");
});

test("buildPluginUiSchema pushes the interface arrays to the end, before the log level", () => {
  const entries = [
    makeUiEntry({ id: "tcp-client", name: "TCP Client Interface" }),
    makeUiEntry({ id: "auto", name: "AutoInterface" }),
    makeUiEntry({ id: "webrtc", name: "WebRTC Interface" }),
  ];
  const ui = buildPluginUiSchema(entries);
  const order = ui["ui:order"];

  // Advanced feature groups land right after the essentials, in declared order.
  const identityIndex = order.indexOf("identity");
  assert.deepEqual(
    order.slice(identityIndex + 1, identityIndex + 1 + ADVANCED_GROUPS.length),
    ADVANCED_GROUPS,
  );

  // The interface arrays come after every advanced group and before log_level.
  // WebRTC is excluded so it never appears.
  const lastAdvanced = order.indexOf(
    ADVANCED_GROUPS[ADVANCED_GROUPS.length - 1],
  );
  const logIndex = order.indexOf("log_level");
  assert.deepEqual(order.slice(lastAdvanced + 1, logIndex), [
    "tcp_clients",
    "auto_interfaces",
  ]);
  assert.ok(!("webrtc_interfaces" in order), "WebRTC is not in the uiSchema");
});

test("buildPluginUiSchema hides the derived identity.publicKey but not the privateKey", () => {
  const ui = buildPluginUiSchema([]);

  // publicKey is readOnly and derived from privateKey, so it is hidden to keep
  // the Identity group focused on the one field users manage.
  assert.deepEqual(ui.identity, { publicKey: HIDDEN });
});

test("buildPluginUiSchema leaves the essentials (messaging, crew, log_level) without a uiSchema entry", () => {
  const ui = buildPluginUiSchema([]);
  // These are intentionally left without a uiSchema entry so the primary
  // fields render with their defaults.
  assert.equal(ui.messaging, undefined);
  assert.equal(ui.crew, undefined);
  assert.equal(ui.log_level, undefined);
  assert.equal(ui.use_shared_instance, undefined);
});

test("buildPluginUiSchema covers exactly every schema top-level property", () => {
  const entries = [
    makeUiEntry({ id: "auto", name: "AutoInterface" }),
    makeUiEntry({ id: "tcp-client", name: "TCP Client Interface" }),
    makeUiEntry({ id: "webrtc", name: "WebRTC Interface" }),
  ];
  const schema = buildPluginSchema(entries);
  const ui = buildPluginUiSchema(entries);

  // Every schema property is accounted for in ui:order, with no extras.
  assert.deepEqual(
    ui["ui:order"].sort(),
    Object.keys(schema.properties).sort(),
  );
});
