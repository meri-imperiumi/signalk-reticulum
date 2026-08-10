/**
 * Reticulum status and statistics reporting to Signal K.
 *
 * Gathers connectivity information from the Reticulum node and formats it
 * for Signal K, similar to how the signalk-meshtastic plugin exposes
 * node information.
 *
 * @file status.js
 */

const { toHex } = require("@reticulum/core");

/**
 * Sanitizes a free-form Reticulum interface name into a stable, path-safe
 * identifier for use as a Signal K path segment.
 *
 * Signal K path segments must not contain whitespace or punctuation, but a
 * Reticulum interface name is free-form text (e.g. "Lille Oe NAS") and so
 * cannot be used verbatim — doing so produces broken paths like
 * `communication.reticulum.interfaces.Lille Oe NAS.bytesReceived`. Any run of
 * characters outside `[a-zA-Z0-9]` (spaces, dots, dashes, slashes, …) collapses
 * to a single underscore, leading/trailing underscores are trimmed, and an
 * empty result falls back to `"interface"` so the segment is never empty.
 *
 * This is an id *derived from the name*, not the name itself: the human-readable
 * `name` is still published verbatim in the `interfaces` array value so
 * dashboards can display it.
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizePathSegment(raw) {
  const cleaned = String(raw || "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "interface";
}

/**
 * Extracts relevant statistics from a Reticulum interface.
 *
 * @param {object} iface - Reticulum interface instance
 * @returns {{id: string, name: string, type: string, online: boolean, bitrate: number, rxb: number, txb: number}|null}
 */
function getInterfaceStats(iface) {
  if (!iface) {
    return null;
  }
  const name = iface.name || "unknown";
  return {
    id: sanitizePathSegment(name),
    name,
    type: iface.constructor?.name || "unknown",
    online: !!iface.online,
    bitrate: Number(iface.bitrate) || 0,
    rxb: Number(iface.rxb) || 0,
    txb: Number(iface.txb) || 0,
  };
}

/**
 * Gathers all relevant status information from a Reticulum node.
 *
 * @param {object} rns - The Reticulum node instance
 * @param {object} [_lxmf] - Optional LXMF router instance
 * @param {object} [_nomadnet] - Optional NomadNet site instance
 * @param {object} [_rfed] - Optional RFed client instance
 * @param {object} [_embeddedPropagation] - Optional embedded LXMF propagation node
 * @param {object} [_embeddedRfed] - Optional embedded RFed federation node
 * @param {object} [identity] - Optional Reticulum identity instance
 * @param {string} [displayName] - Optional display name
 * @returns {Promise<{identityHash: string, displayName: string, interfaces: object[], links: number, destinationsKnown: number, interfacesConnected: number, bytesReceived: number, bytesTransmitted: number, lxmfPropagationNode: string|null, rfedNode: string|null, embeddedPropagationRunning: boolean, propagationStored: number, embeddedRfedRunning: boolean, rfedBlobsStored: number, rfedSubscriptions: number}>}
 */
async function getStatus(
  rns,
  _lxmf,
  _nomadnet,
  _rfed,
  _embeddedPropagation,
  _embeddedRfed,
  identity,
  displayName,
) {
  const interfaces = [];
  let interfacesConnected = 0;
  let bytesReceived = 0;
  let bytesTransmitted = 0;

  if (rns?.transport?.interfaces) {
    for (const iface of rns.transport.interfaces) {
      const stats = getInterfaceStats(iface);
      if (stats) {
        interfaces.push(stats);
        if (stats.online) {
          interfacesConnected += 1;
        }
        bytesReceived += stats.rxb;
        bytesTransmitted += stats.txb;
      }
    }
  }

  // Ensure each interface has a unique path-safe id so the per-interface
  // Signal K paths never collide when two names sanitize to the same segment
  // (e.g. "Lille Oe" and "Lille.Oe" both → "Lille_Oe"). The first occurrence
  // keeps its base id; later collisions get a `_2`, `_3`, … suffix.
  const usedIds = new Set();
  for (const stats of interfaces) {
    let id = stats.id;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    usedIds.add(id);
    stats.id = id;
  }

  let links = 0;
  // activeLinks is a Map of established transport connections
  // These are ephemeral and exist only during active exchanges
  if (rns?.transport?.activeLinks) {
    links = rns.transport.activeLinks.size;
  }

  let destinationsKnown = 0;
  // The routing table contains learned destinations from announces
  if (rns?.transport?.routingTable?.routes) {
    destinationsKnown = rns.transport.routingTable.routes.size;
  }

  // Check embedded nodes
  const embeddedPropagationRunning = !!_lxmf?.propagationNode;
  const embeddedRfedRunning = !!_embeddedRfed;

  // Get propagation node stats and destination hash
  let propagationStored = 0;
  let propagationNodeHash = null;
  if (embeddedPropagationRunning && _lxmf.propagationDest) {
    propagationStored = _lxmf.propagationNode.store.size || 0;
    // Get the propagation node's destination hash from the destination
    try {
      if (_lxmf.propagationDest.destinationHash) {
        propagationNodeHash = toHex(_lxmf.propagationDest.destinationHash);
      }
    } catch (e) {
    }
  }

  // Get RFed node stats and destination hash
  let rfedBlobsStored = 0;
  let rfedSubscriptions = 0;
  let rfedNodeHash = null;
  if (embeddedRfedRunning) {
    rfedBlobsStored = _embeddedRfed?.blobStore?.allMessageIds
      ? _embeddedRfed.blobStore.allMessageIds().length || 0
      : 0;
    rfedSubscriptions = _embeddedRfed?.subscriptions?.length || 0;
    // Derive the RFed node's destination hash from its identity
    // For the node's own destination, use the node identity directly
    try {
      const {
        deliveryHashFor,
      } = require("@reticulum/core/src/rfed/channel.js");
      const hashArray = await deliveryHashFor(_embeddedRfed.identity);
      rfedNodeHash = toHex(hashArray);
    } catch (e) {
      // If we can't derive the hash, it's null
      rfedNodeHash = null;
    }
  }

  return {
    identityHash: identity?.identityHash ? toHex(identity.identityHash) : "",
    displayName: displayName || "",
    interfaces,
    links,
    destinationsKnown,
    interfacesConnected,
    bytesReceived,
    bytesTransmitted,
    lxmfPropagationNode: propagationNodeHash,
    rfedNode: rfedNodeHash,
    embeddedPropagationRunning,
    propagationStored,
    embeddedRfedRunning,
    rfedBlobsStored,
    rfedSubscriptions,
  };
}

/**
 * Formats status information as Signal K values for `vessels.self`.
 *
 * @param {object} rns - The Reticulum node instance
 * @param {object} [lxmf] - Optional LXMF router instance
 * @param {object} [nomadnet] - Optional NomadNet site instance
 * @param {object} [rfed] - Optional RFed client instance
 * @param {object} [embeddedPropagation] - Optional embedded LXMF propagation node
 * @param {object} [embeddedRfed] - Optional embedded RFed federation node
 * @param {object} [identity] - Optional Reticulum identity instance
 * @param {string} [displayName] - Optional display name
 * @returns {Promise<{path: string, value: any}[]>}
 */
async function formatStatusValues(
  rns,
  lxmf,
  nomadnet,
  rfed,
  embeddedPropagation,
  embeddedRfed,
  identity,
  displayName,
) {
  const status = await getStatus(
    rns,
    lxmf,
    nomadnet,
    rfed,
    embeddedPropagation,
    embeddedRfed,
    identity,
    displayName,
  );
  const values = [
    {
      path: "communication.reticulum.identityHash",
      value: status.identityHash,
    },
    {
      path: "communication.reticulum.displayName",
      value: status.displayName,
    },
    {
      path: "communication.reticulum.interfacesConnected",
      value: status.interfacesConnected,
    },
    {
      path: "communication.reticulum.links",
      value: status.links,
    },
    {
      path: "communication.reticulum.destinationsKnown",
      value: status.destinationsKnown,
    },

    {
      path: "communication.reticulum.bytesReceived",
      value: status.bytesReceived,
    },
    {
      path: "communication.reticulum.bytesTransmitted",
      value: status.bytesTransmitted,
    },
    {
      path: "communication.reticulum.interfaces",
      value: status.interfaces.map((iface) => ({
        id: iface.id,
        name: iface.name,
        type: iface.type,
        online: iface.online,
        bitrate: iface.bitrate,
        bytesReceived: iface.rxb,
        bytesTransmitted: iface.txb,
      })),
    },
    {
      path: "communication.reticulum.lxmfPropagationNode",
      value: status.lxmfPropagationNode,
    },
    {
      path: "communication.reticulum.rfedNode",
      value: status.rfedNode,
    },
  ];

  // Add per-interface traffic stats. The path segment is the interface's
  // sanitized id (see sanitizePathSegment) — never the free-form name — so a
  // name with whitespace or special characters (e.g. "Lille Oe NAS") cannot
  // produce an invalid Signal K path.
  for (const iface of status.interfaces) {
    values.push(
      {
        path: `communication.reticulum.interfaces.${iface.id}.bytesReceived`,
        value: iface.rxb,
      },
      {
        path: `communication.reticulum.interfaces.${iface.id}.bytesTransmitted`,
        value: iface.txb,
      },
    );
  }

  // Add embedded nodes status
  values.push(
    {
      path: "communication.reticulum.embeddedPropagationRunning",
      value: status.embeddedPropagationRunning,
    },
    {
      path: "communication.reticulum.propagationStored",
      value: status.propagationStored,
    },
    {
      path: "communication.reticulum.embeddedRfedRunning",
      value: status.embeddedRfedRunning,
    },
    {
      path: "communication.reticulum.rfedBlobsStored",
      value: status.rfedBlobsStored,
    },
    {
      path: "communication.reticulum.rfedSubscriptions",
      value: status.rfedSubscriptions,
    },
  );

  return values;
}

/**
 * Returns metadata definitions for all Signal K paths published by this module.
 *
 * @returns {{path: string, value: object}[]}
 */
function getStatusMetadata() {
  return [
    {
      path: "communication.reticulum.identityHash",
      value: {
        displayName: "Identity hash",
        description:
          "Unique 32-character hex identifier for this Reticulum node",
      },
    },
    {
      path: "communication.reticulum.displayName",
      value: {
        displayName: "Display name",
        description: "Human-readable name announced by this node",
      },
    },
    {
      path: "communication.reticulum.interfacesConnected",
      value: {
        displayName: "Interfaces connected",
        description: "Number of interfaces currently online",
        units: "count",
      },
    },
    {
      path: "communication.reticulum.links",
      value: {
        displayName: "Active links",
        description:
          "Number of active transport connections (ephemeral, non-zero only during active exchanges)",
        units: "count",
      },
    },
    {
      path: "communication.reticulum.destinationsKnown",
      value: {
        displayName: "Destinations known",
        description:
          "Number of remote destinations in the routing table (peers reachable via announces)",
        units: "count",
      },
    },

    {
      path: "communication.reticulum.interfaces",
      value: {
        displayName: "Interfaces",
        description:
          "List of all Reticulum interfaces and their status. Each entry " +
          "carries a path-safe id (used as the per-interface path segment), " +
          "the human-readable name, type, online flag, bitrate and " +
          "bytesReceived/bytesTransmitted traffic counters.",
        type: "array",
      },
    },
    {
      path: "communication.reticulum.bytesReceived",
      value: {
        displayName: "Bytes received",
        description: "Total bytes received across all interfaces",
        units: "bytes",
      },
    },
    {
      path: "communication.reticulum.bytesTransmitted",
      value: {
        displayName: "Bytes transmitted",
        description: "Total bytes transmitted across all interfaces",
        units: "bytes",
      },
    },
    {
      path: "communication.reticulum.lxmfPropagationNode",
      value: {
        displayName: "LXMF propagation node",
        description:
          "If running an embedded LXMF propagation node, the 32-character destination hash of the node. Otherwise null when not running an embedded propagation node.",
        type: "string",
        pattern: "^[0-9a-f]{32}$",
      },
    },
    {
      path: "communication.reticulum.rfedNode",
      value: {
        displayName: "RFed federation node",
        description:
          "If running an embedded RFed federation node, the 32-character destination hash of the node. Otherwise null when not running an embedded RFed.",
        type: "string",
        pattern: "^[0-9a-f]{32}$",
      },
    },
    {
      path: "communication.reticulum.embeddedPropagationRunning",
      value: {
        displayName: "Embedded LXMF propagation node",
        description:
          "Whether the plugin is running an embedded LXMF propagation node",
        type: "boolean",
      },
    },
    {
      path: "communication.reticulum.propagationStored",
      value: {
        displayName: "Propagation stored messages",
        description:
          "Number of messages stored in the embedded LXMF propagation node",
        units: "count",
      },
    },
    {
      path: "communication.reticulum.embeddedRfedRunning",
      value: {
        displayName: "Embedded RFed federation node",
        description:
          "Whether the plugin is running an embedded RFed federation node",
        type: "boolean",
      },
    },
    {
      path: "communication.reticulum.rfedBlobsStored",
      value: {
        displayName: "RFed stored blobs",
        description:
          "Number of blobs stored in the embedded RFed federation node",
        units: "count",
      },
    },
    {
      path: "communication.reticulum.rfedSubscriptions",
      value: {
        displayName: "RFed channel subscriptions",
        description:
          "Number of channel subscriptions in the embedded RFed federation node",
        units: "count",
      },
    },
  ];
}

module.exports = {
  sanitizePathSegment,
  getInterfaceStats,
  getStatus,
  formatStatusValues,
  getStatusMetadata,
};
