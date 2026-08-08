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
 * Extracts relevant statistics from a Reticulum interface.
 *
 * @param {object} iface - Reticulum interface instance
 * @returns {{name: string, type: string, online: boolean, bitrate: number, rxb: number, txb: number}|null}
 */
function getInterfaceStats(iface) {
  if (!iface) {
    return null;
  }
  return {
    name: iface.name || "unknown",
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
 * @param {object} [identity] - Optional Reticulum identity instance
 * @param {string} [displayName] - Optional display name
 * @returns {{identityHash: string, displayName: string, interfaces: object[], links: number, destinationsKnown: number, interfacesConnected: number, bytesReceived: number, bytesTransmitted: number}}
 */
function getStatus(rns, _lxmf, _nomadnet, _rfed, identity, displayName) {
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

  return {
    identityHash: identity?.identityHash ? toHex(identity.identityHash) : "",
    displayName: displayName || "",
    interfaces,
    links,
    destinationsKnown,
    interfacesConnected,
    bytesReceived,
    bytesTransmitted,
  };
}

/**
 * Formats status information as Signal K values for `vessels.self`.
 *
 * @param {object} rns - The Reticulum node instance
 * @param {object} [lxmf] - Optional LXMF router instance
 * @param {object} [nomadnet] - Optional NomadNet site instance
 * @param {object} [rfed] - Optional RFed client instance
 * @param {object} [identity] - Optional Reticulum identity instance
 * @param {string} [displayName] - Optional display name
 * @returns {{path: string, value: any}[]}
 */
function formatStatusValues(rns, lxmf, nomadnet, rfed, identity, displayName) {
  const status = getStatus(rns, lxmf, nomadnet, rfed, identity, displayName);
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
        name: iface.name,
        type: iface.type,
        online: iface.online,
        bitrate: iface.bitrate,
      })),
    },
  ];

  // Add per-interface traffic stats
  for (const iface of status.interfaces) {
    const escapedName = iface.name.replace(/\./g, "_");
    values.push(
      {
        path: `communication.reticulum.interfaces.${escapedName}.bytesReceived`,
        value: iface.rxb,
      },
      {
        path: `communication.reticulum.interfaces.${escapedName}.bytesTransmitted`,
        value: iface.txb,
      },
    );
  }

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
        description: "List of all Reticulum interfaces and their status",
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
  ];
}

module.exports = {
  getInterfaceStats,
  getStatus,
  formatStatusValues,
  getStatusMetadata,
};
