// Status module smoketest
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizePathSegment,
  getInterfaceStats,
  getStatus,
  formatStatusValues,
  getStatusMetadata,
} = require("../plugin/status.js");

test("getStatusMetadata returns metadata for all paths", () => {
  const metadata = getStatusMetadata();

  // Check that we have the expected paths
  const paths = metadata.map((m) => m.path);
  assert.ok(paths.includes("communication.reticulum.identityHash"));
  assert.ok(paths.includes("communication.reticulum.displayName"));
  assert.ok(paths.includes("communication.reticulum.interfacesConnected"));
  assert.ok(paths.includes("communication.reticulum.links"));
  assert.ok(paths.includes("communication.reticulum.destinationsKnown"));
  assert.ok(
    !paths.includes("communication.reticulum.lxmfPeers"),
    "lxmfPeers is not exposed",
  );
  assert.ok(paths.includes("communication.reticulum.interfaces"));

  // Check that each metadata entry has required fields
  for (const m of metadata) {
    assert.ok(m.value, `metadata for ${m.path} has value`);
    assert.ok(
      m.value.displayName || m.value.description,
      `metadata for ${m.path} has displayName or description`,
    );
  }
});

test("`formatStatusValues handles null/undefined RNS returns null/undefined RNS", async () => {
  const values = await formatStatusValues(null, null, null, null);

  // Should still return values, just with defaults
  assert.ok(Array.isArray(values));
  assert.ok(values.length > 0);

  // Find identityHash value
  const identityHash = values.find(
    (v) => v.path === "communication.reticulum.identityHash",
  );
  assert.ok(identityHash);
  assert.equal(identityHash.value, "");
});

test("formatStatusValues extracts interface info", async () => {
  const mockIdentity = {
    identityHash: Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
  };
  const mockRns = {
    transport: {
      interfaces: new Set([
        {
          name: "tcp-client-1",
          constructor: { name: "TCPClient" },
          online: true,
          bitrate: 1000000,
          rxb: 12345,
          txb: 67890,
        },
        {
          name: "lora-node",
          constructor: { name: "RNodeInterface" },
          online: false,
          bitrate: 9600,
          rxb: 0,
          txb: 0,
        },
      ]),
      activeLinks: new Map([
        ["link1", {}],
        ["link2", {}],
      ]), // 2 links
      routingTable: {
        routes: new Map([
          ["dest1", {}],
          ["dest2", {}],
          ["lxmf.delivery.peer1", {}],
        ]),
      },
    },
  };

  const values = await formatStatusValues(
    mockRns,
    null,
    null,
    null,
    null,
    null,
    mockIdentity,
    "Test Node",
  );

  // Check identity hash
  const identityHash = values.find(
    (v) => v.path === "communication.reticulum.identityHash",
  );
  assert.equal(identityHash.value, "0123456789abcdef0123456789abcdef");

  // Check display name
  const displayName = values.find(
    (v) => v.path === "communication.reticulum.displayName",
  );
  assert.equal(displayName.value, "Test Node");

  // Check interfaces count
  const interfacesConnected = values.find(
    (v) => v.path === "communication.reticulum.interfacesConnected",
  );
  assert.equal(interfacesConnected.value, 1); // only tcp-client-1 is online

  // Check links count
  const links = values.find((v) => v.path === "communication.reticulum.links");
  assert.equal(links.value, 2);

  // Check destinations known
  const destinationsKnown = values.find(
    (v) => v.path === "communication.reticulum.destinationsKnown",
  );
  assert.equal(destinationsKnown.value, 3); // all 3 entries

  // Check total bytes
  const bytesReceived = values.find(
    (v) => v.path === "communication.reticulum.bytesReceived",
  );
  assert.equal(bytesReceived.value, 12345); // sum of all interfaces

  const bytesTransmitted = values.find(
    (v) => v.path === "communication.reticulum.bytesTransmitted",
  );
  assert.equal(bytesTransmitted.value, 67890); // sum of all interfaces

  // Check interfaces array
  const interfaces = values.find(
    (v) => v.path === "communication.reticulum.interfaces",
  );
  assert.ok(interfaces.value);
  assert.equal(interfaces.value.length, 2);
  assert.equal(interfaces.value[0].id, "tcp_client_1");
  assert.equal(interfaces.value[0].name, "tcp-client-1");
  assert.equal(interfaces.value[0].type, "TCPClient");
  assert.equal(interfaces.value[0].online, true);
  assert.equal(interfaces.value[0].bitrate, 1000000);
  assert.equal(interfaces.value[0].bytesReceived, 12345);
  assert.equal(interfaces.value[0].bytesTransmitted, 67890);

  // Check per-interface traffic stats. Dashes are special characters and are
  // sanitized to underscores so the path segment stays Signal-K-safe.
  const tcpRxb = values.find(
    (v) =>
      v.path ===
      "communication.reticulum.interfaces.tcp_client_1.bytesReceived",
  );
  assert.equal(tcpRxb.value, 12345);

  const tcpTxb = values.find(
    (v) =>
      v.path ===
      "communication.reticulum.interfaces.tcp_client_1.bytesTransmitted",
  );
  assert.equal(tcpTxb.value, 67890);

  const loraRxb = values.find(
    (v) =>
      v.path === "communication.reticulum.interfaces.lora_node.bytesReceived",
  );
  assert.equal(loraRxb.value, 0);
});

test("getStatusMetadata does not include lxmfPeers", () => {
  const metadata = getStatusMetadata();

  const paths = metadata.map((m) => m.path);
  assert.ok(!paths.includes("communication.reticulum.lxmfPeers"));
});

test("getStatusMetadata includes bytesReceived and bytesTransmitted", () => {
  const metadata = getStatusMetadata();

  const paths = metadata.map((m) => m.path);
  assert.ok(paths.includes("communication.reticulum.bytesReceived"));
  assert.ok(paths.includes("communication.reticulum.bytesTransmitted"));

  const bytesReceivedMeta = metadata.find(
    (m) => m.path === "communication.reticulum.bytesReceived",
  );
  assert.equal(bytesReceivedMeta.value.units, "bytes");

  const bytesTransmittedMeta = metadata.find(
    (m) => m.path === "communication.reticulum.bytesTransmitted",
  );
  assert.equal(bytesTransmittedMeta.value.units, "bytes");
});

test("sanitizePathSegment produces path-safe ids from free-form names", () => {
  assert.equal(sanitizePathSegment("Lille Oe NAS"), "Lille_Oe_NAS");
  // Safe names (alphanumeric + underscore) pass through unchanged.
  assert.equal(sanitizePathSegment("tcp_client_1"), "tcp_client_1");
  // Dots, dashes, slashes and repeated separators collapse to one underscore.
  assert.equal(sanitizePathSegment("Lille.Oe.NAS"), "Lille_Oe_NAS");
  assert.equal(sanitizePathSegment("tcp-client-1"), "tcp_client_1");
  assert.equal(sanitizePathSegment("lora-node"), "lora_node");
  assert.equal(sanitizePathSegment("tcp/client--1"), "tcp_client_1");
  // Leading/trailing separators are trimmed.
  assert.equal(sanitizePathSegment("  trailing  "), "trailing");
  // Empty / non-string input falls back to a non-empty id.
  assert.equal(sanitizePathSegment(""), "interface");
  assert.equal(sanitizePathSegment("!!!"), "interface");
  assert.equal(sanitizePathSegment(undefined), "interface");
  assert.equal(sanitizePathSegment(null), "interface");
});

test("getInterfaceStats derives a sanitized id alongside the name", () => {
  const stats = getInterfaceStats({
    name: "Lille Oe NAS",
    constructor: { name: "TCPClient" },
    online: true,
    bitrate: 1000,
    rxb: 5,
    txb: 7,
  });
  assert.equal(stats.id, "Lille_Oe_NAS");
  assert.equal(stats.name, "Lille Oe NAS");
  assert.equal(stats.type, "TCPClient");
});

test("per-interface paths use sanitized ids and never contain whitespace", async () => {
  const mockRns = {
    transport: {
      interfaces: new Set([
        {
          name: "Lille Oe NAS",
          constructor: { name: "TCPClient" },
          online: true,
          bitrate: 1000000,
          rxb: 111,
          txb: 222,
        },
      ]),
      activeLinks: new Map(),
      routingTable: { routes: new Map() },
    },
  };

  const values = await formatStatusValues(
    mockRns,
    null,
    null,
    null,
    null,
    null,
    null,
    "",
  );

  const rxb = values.find(
    (v) =>
      v.path ===
      "communication.reticulum.interfaces.Lille_Oe_NAS.bytesReceived",
  );
  assert.ok(rxb, "sanitized per-interface bytesReceived path exists");
  assert.equal(rxb.value, 111);

  const txb = values.find(
    (v) =>
      v.path ===
      "communication.reticulum.interfaces.Lille_Oe_NAS.bytesTransmitted",
  );
  assert.ok(txb);
  assert.equal(txb.value, 222);

  // No emitted path may contain whitespace or the raw name verbatim.
  assert.ok(
    values.every((v) => !/\s/.test(v.path)),
    "no path contains whitespace",
  );
  assert.ok(
    values.every((v) => !v.path.includes("Lille Oe NAS")),
    "no path contains the raw free-form name",
  );
});

test("per-interface ids are unique when names collide after sanitization", async () => {
  // Both "Lille Oe" and "Lille.Oe" sanitize to "Lille_Oe"; the second must
  // get a suffix so the two interfaces do not overwrite each other's paths.
  const mockRns = {
    transport: {
      interfaces: new Set([
        {
          name: "Lille Oe",
          constructor: { name: "TCPClient" },
          online: true,
          bitrate: 1,
          rxb: 10,
          txb: 20,
        },
        {
          name: "Lille.Oe",
          constructor: { name: "AutoInterface" },
          online: true,
          bitrate: 1,
          rxb: 30,
          txb: 40,
        },
      ]),
      activeLinks: new Map(),
      routingTable: { routes: new Map() },
    },
  };

  const values = await formatStatusValues(
    mockRns,
    null,
    null,
    null,
    null,
    null,
    null,
    "",
  );
  const rxbPaths = values
    .filter(
      (v) =>
        v.path.startsWith("communication.reticulum.interfaces.") &&
        v.path.endsWith(".bytesReceived"),
    )
    .map((v) => v.path);

  // Two distinct, non-colliding paths.
  assert.equal(new Set(rxbPaths).size, 2);
  assert.ok(
    rxbPaths.includes(
      "communication.reticulum.interfaces.Lille_Oe.bytesReceived",
    ),
  );
  assert.ok(
    rxbPaths.includes(
      "communication.reticulum.interfaces.Lille_Oe_2.bytesReceived",
    ),
  );

  // Each path carries the right interface's counter (no overwrite).
  const first = values.find(
    (v) =>
      v.path === "communication.reticulum.interfaces.Lille_Oe.bytesReceived",
  );
  const second = values.find(
    (v) =>
      v.path === "communication.reticulum.interfaces.Lille_Oe_2.bytesReceived",
  );
  assert.equal(first.value, 10);
  assert.equal(second.value, 30);

  // The interfaces array reports both unique ids with their human names.
  const interfaces = values.find(
    (v) => v.path === "communication.reticulum.interfaces",
  );
  const ids = interfaces.value.map((iface) => iface.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(interfaces.value.map((iface) => iface.name).sort(), [
    "Lille Oe",
    "Lille.Oe",
  ]);
});
