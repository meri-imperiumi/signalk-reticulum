// Status module smoketest
const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
  assert.ok(paths.includes("communication.reticulum.lxmfPeers"));
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

test("formatStatusValues handles null/undefined RNS", () => {
  const values = formatStatusValues(null, null, null, null);

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

test("formatStatusValues extracts interface info", () => {
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
      links: new Set([{}, {}]), // 2 links
      pathTable: new Map([
        ["dest1", {}],
        ["dest2", {}],
        ["lxmf.delivery.peer1", { appData: { name: "lxmf.delivery.peer1" } }],
      ]),
    },
  };

  const values = formatStatusValues(
    mockRns,
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

  // Check LXMF peers
  const lxmfPeers = values.find(
    (v) => v.path === "communication.reticulum.lxmfPeers",
  );
  assert.equal(lxmfPeers.value, 1); // only peer1 is an lxmf.delivery

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
  assert.equal(interfaces.value[0].name, "tcp-client-1");
  assert.equal(interfaces.value[0].type, "TCPClient");
  assert.equal(interfaces.value[0].online, true);
  assert.equal(interfaces.value[0].bitrate, 1000000);

  // Check per-interface traffic stats
  const tcpRxb = values.find(
    (v) =>
      v.path ===
      "communication.reticulum.interfaces.tcp-client-1.bytesReceived",
  );
  assert.equal(tcpRxb.value, 12345);

  const tcpTxb = values.find(
    (v) =>
      v.path ===
      "communication.reticulum.interfaces.tcp-client-1.bytesTransmitted",
  );
  assert.equal(tcpTxb.value, 67890);

  const loraRxb = values.find(
    (v) =>
      v.path === "communication.reticulum.interfaces.lora-node.bytesReceived",
  );
  assert.equal(loraRxb.value, 0);
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
