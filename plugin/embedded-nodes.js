/**
 * Embedded LXMF propagation node and RFed federation node support.
 *
 * When enabled, the plugin runs an LXMF propagation node and/or an RFed
 * federation node directly inside the plugin process, sharing the Reticulum
 * instance and identity with the rest of the plugin. This provides
 * store-and-forward messaging and channel telemetry services to the mesh
 * without requiring external nodes.
 *
 * The nodes use the same disk-persisted stores as the standalone
 * @reticulum/node CLI tools, so state survives restarts.
 *
 * @file embedded-nodes.js
 */

const RNS = require("@reticulum/core");
// LXMF and RFed moved out of the package root in @reticulum/core 0.6 —
// deep-import them by subpath.
const { RFedNode } = require("@reticulum/core/src/rfed/index.js");

// Storage utilities from @reticulum/node (CommonJS build)
let storageLxmf, storageRfed;
try {
  const nodePath = require.resolve("@reticulum/node");
  storageLxmf = require(`${nodePath}/../build/storage/lxmf.cjs`);
  storageRfed = require(`${nodePath}/../build/storage/rfed.cjs`);
} catch (_e) {
  // Fall back to source if build not available (dev mode)
  try {
    storageLxmf = require("@reticulum/node/src/storage/lxmf.js");
    storageRfed = require("@reticulum/node/src/storage/rfed.js");
  } catch (_e2) {
    console.warn("Could not load @reticulum/node storage modules");
  }
}

const { loadLXMFStore, saveLXMFStore } = storageLxmf || {
  loadLXMFStore: null,
  saveLXMFStore: null,
};
const { loadRFedStores, saveRFedStores } = storageRfed || {
  loadRFedStores: null,
  saveRFedStores: null,
};

/** Default maintenance interval (seconds) - same as rfed CLI */
const MAINTENANCE_INTERVAL_DEFAULT = 3600;
/** Default backup interval (seconds) - same as rfed CLI */
const BACKUP_INTERVAL_DEFAULT = 30;
/** Default blob TTL (days) */
const BLOB_TTL_DAYS_DEFAULT = 30;
/** Default deferred TTL (days) */
const DEFERRED_TTL_DAYS_DEFAULT = 7;

/** Injected dependencies; tests swap these for fakes. */
const deps = {
  RFedNode,
  loadLXMFStore,
  saveLXMFStore,
  loadRFedStores,
  saveRFedStores,
};

/**
 * Sets up an embedded LXMF propagation node on the given LXMF router.
 *
 * The propagation node is configured with:
 * - A disk-persisted message store (if storage is available)
 * - Configurable stamp cost (default 8)
 * - Autopeering disabled by default (can be enabled in config)
 * - Static propagation peers (optional)
 *
 * @param {object} options
 * @param {object} options.lxmf - The LXMRouter instance
 * @param {object} options.identity - The Reticulum identity
 * @param {object} options.config - Plugin configuration
 * @param {string|null} options.dataDir - Plugin data directory (for storage)
 * @param {(...args:any[])=>void} options.log - Logger function
 * @returns {Promise<{node: object|null, teardown: ()=>void}>}
 */
async function setupEmbeddedPropagationNode({
  lxmf,
  config,
  dataDir,
  log = () => {},
}) {
  if (!deps.loadLXMFStore || !deps.saveLXMFStore) {
    log("LXMF storage modules not available; propagation node disabled");
    return { node: null, teardown: () => {} };
  }

  const propConfig = config?.embedded_nodes?.propagation || {};
  const enabled = propConfig.enabled !== false; // Default to true

  if (!enabled) {
    log("Embedded LXMF propagation node disabled in config");
    return { node: null, teardown: () => {} };
  }

  if (!lxmf) {
    log("LXMF router not available; cannot start propagation node");
    return { node: null, teardown: () => {} };
  }

  const stampCost = Number(propConfig.stamp_cost) || 8;
  const peeringCost = Number(propConfig.peering_cost) || 18;
  const autopeer = !!propConfig.autopeer;
  const autopeerMaxCost = Number(propConfig.autopeer_max_cost) || 18;
  const storageLimitMb = Number(propConfig.storage_limit_mb) || null;
  const messageTtlDays = Number(propConfig.message_ttl_days) || null;

  const storageLimitBytes = storageLimitMb
    ? storageLimitMb * 1000 * 1000
    : null;
  const messageTtlSecs = messageTtlDays ? messageTtlDays * 24 * 3600 : null;

  let store;
  if (dataDir) {
    try {
      const propDataDir = `${dataDir}/propagation`;
      store = await deps.loadLXMFStore(propDataDir, {
        storageLimitBytes,
        messageTtlSecs,
      });
      log(
        `Loaded LXMF propagation store from ${propDataDir}: ${store.size} message(s)`,
      );
    } catch (e) {
      log(`Failed to load LXMF propagation store: ${e.message}`);
      store = null;
    }
  }

  try {
    const propagationNode = await lxmf.enablePropagation({
      stampCost,
      name: propConfig.name || config?.messaging?.display_name || undefined,
      peeringCost,
      storageLimitBytes,
      messageTtlSecs,
      store,
    });

    if (autopeer) {
      lxmf.enableAutopeer(autopeerMaxCost);
    }

    await lxmf.announcePropagationNode();
    log(
      `Embedded LXMF propagation node started (stamp cost ${stampCost}, ` +
        `peering cost ${peeringCost}${autopeer ? `, autopeer max cost ${autopeerMaxCost}` : ""})`,
    );

    // Set up periodic sync with configured propagation peers
    let syncTimer = null;
    const peers = Array.isArray(propConfig.peers)
      ? propConfig.peers.filter((p) => typeof p === "string" && p.length === 32)
      : [];
    if (peers.length > 0 && lxmf.syncPeers) {
      const syncOnce = async () => {
        try {
          await lxmf.syncPeers();
          log("LXMF propagation peer sync completed");
        } catch (e) {
          log(`LXMF propagation peer sync failed: ${e.message}`);
        }
      };
      // Initial sync after 5 seconds
      const _initialSync = setTimeout(syncOnce, 5000);
      // Periodic sync every 5 minutes
      const intervalMs = 5 * 60 * 1000;
      syncTimer = setInterval(syncOnce, intervalMs);
      log(`LXMF propagation syncing with ${peers.length} peer(s)`);
    }

    // Periodic maintenance: prune old messages and persist store
    let maintenanceTimer = null;
    const maintenanceIntervalMs = 60 * 60 * 1000; // 1 hour default
    if (dataDir) {
      const runMaintenance = async () => {
        try {
          const { aged } = propagationNode.tickMaintenance();
          if (aged > 0) {
            log(`LXMF propagation maintenance: pruned ${aged} aged message(s)`);
          }
          const propDataDir = `${dataDir}/propagation`;
          await deps.saveLXMFStore(propDataDir, propagationNode.store);
        } catch (e) {
          log(`LXMF propagation maintenance failed: ${e.message}`);
        }
      };
      maintenanceTimer = setInterval(runMaintenance, maintenanceIntervalMs);
    }

    const teardown = () => {
      if (initialSync) clearTimeout(initialSync);
      if (syncTimer) clearInterval(syncTimer);
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      // Final persist on shutdown
      if (dataDir && propagationNode?.store) {
        Promise.resolve()
          .then(async () => {
            try {
              const propDataDir = `${dataDir}/propagation`;
              await deps.saveLXMFStore(propDataDir, propagationNode.store);
              log("LXMF propagation store persisted on shutdown");
            } catch (e) {
              log(`LXMF propagation final persist failed: ${e.message}`);
            }
          })
          .catch(() => {});
      }
    };

    return { node: propagationNode, teardown };
  } catch (e) {
    log(`Failed to start embedded LXMF propagation node: ${e.message}`);
    return { node: null, teardown: () => {} };
  }
}

/**
 * Sets up an embedded RFed federation node.
 *
 * The RFed node is configured with:
 * - Disk-persisted stores (blob store, subscriptions, deferred, notify)
 * - Configurable stamp cost and stamp flexibility (default 16/3)
 * - Periodic maintenance and persistence
 * - Backup failover support (optional)
 * - Static peer sync (optional)
 *
 * @param {object} options
 * @param {object} options.rns - The Reticulum instance
 * @param {object} options.identity - The Reticulum identity
 * @param {object} options.config - Plugin configuration
 * @param {string|null} options.dataDir - Plugin data directory (for storage)
 * @param {(...args:any[])=>void} options.log - Logger function
 * @returns {Promise<{node: object|null, teardown: ()=>void}>}
 */
async function setupEmbeddedRFedNode({
  rns,
  identity,
  config,
  dataDir,
  log = () => {},
}) {
  if (!deps.loadRFedStores || !deps.saveRFedStores) {
    log("RFed storage modules not available; federation node disabled");
    return { node: null, teardown: () => {} };
  }

  const rfedConfig = config?.embedded_nodes?.rfed || {};
  const enabled = rfedConfig.enabled !== false; // Default to true

  if (!enabled) {
    log("Embedded RFed federation node disabled in config");
    return { node: null, teardown: () => {} };
  }

  const stampCost = Number(rfedConfig.stamp_cost) || 16;
  const stampFlex = Number(rfedConfig.stamp_flexibility) || 3;
  const maintenanceInterval =
    Number(rfedConfig.maintenance_interval_seconds) ||
    MAINTENANCE_INTERVAL_DEFAULT;
  const _backupInterval =
    Number(rfedConfig.backup_interval_seconds) || BACKUP_INTERVAL_DEFAULT;
  const blobTtlDays = Number(rfedConfig.blob_ttl_days) || BLOB_TTL_DAYS_DEFAULT;
  const deferredTtlDays =
    Number(rfedConfig.deferred_ttl_days) || DEFERRED_TTL_DAYS_DEFAULT;
  const storageLimitMb = Number(rfedConfig.storage_limit_mb) || null;

  const storageLimitBytes = storageLimitMb
    ? storageLimitMb * 1000 * 1000
    : null;
  const blobTtlSecs = blobTtlDays * 24 * 3600;
  const deferredTtlSecs = deferredTtlDays * 24 * 3600;

  let stores;
  if (dataDir) {
    try {
      const rfedDataDir = `${dataDir}/rfed`;
      stores = await deps.loadRFedStores(rfedDataDir, {
        storageLimitBytes,
      });
      log(
        `Loaded RFed stores from ${rfedDataDir}: ` +
          `${stores.blobStore.allMessageIds().length} blob(s), ` +
          `${stores.subscriptions.length} subscription(s), ` +
          `${stores.deferred.totalLen()} deferred, ` +
          `${stores.notify.count} notify registration(s).`,
      );
    } catch (e) {
      log(`Failed to load RFed stores: ${e.message}`);
      stores = null;
    }
  }

  if (!stores) {
    // Create empty stores if no data directory
    const { BlobStore, SubscriptionTable, DeferredQueue, NotifyRegistry } =
      require("@reticulum/core/src/rfed/index.js");
    stores = {
      blobStore: new BlobStore({ storageLimitBytes }),
      subscriptions: new SubscriptionTable(),
      deferred: new DeferredQueue(),
      notify: new NotifyRegistry(),
    };
  }

  try {
    const node = new deps.RFedNode({
      identity,
      rns,
      stores,
      config: {
        name: rfedConfig.name || "rfed",
        stampCost,
        stampFlexibility: stampFlex,
        storageLimitBytes,
        blobTtlSecs,
        deferredTtlSecs,
      },
    });

    await node.start();
    log(
      `Embedded RFed federation node started ` +
        `(stamp cost ${stampCost}, flex ${stampFlex})`,
    );

    // Set up periodic maintenance and persistence
    const maintenanceTimer = setInterval(async () => {
      try {
        const { blobsEvicted, deferredEvicted } = node.tickMaintenance();
        if (dataDir) {
          const rfedDataDir = `${dataDir}/rfed`;
          await deps.saveRFedStores(rfedDataDir, {
            blobStore: node.blobStore,
            subscriptions: node.subscriptions,
            deferred: node.deferred,
            notify: node.notifyRegistry,
          });
        }
        if (blobsEvicted || deferredEvicted) {
          log(
            `RFed maintenance: evicted ${blobsEvicted} blob(s), ${deferredEvicted} deferred; persisted.`,
          );
        }
      } catch (e) {
        log(`RFed maintenance/persist failed: ${e.message}`);
      }
    }, maintenanceInterval * 1000);

    // Set up periodic sync with configured peers
    let syncTimer = null;
    const peers = Array.isArray(rfedConfig.sync_peers)
      ? rfedConfig.sync_peers.filter(
          (p) => typeof p === "string" && p.length === 32,
        )
      : [];
    if (peers.length > 0) {
      const syncOnce = async () => {
        for (const peerHex of peers) {
          try {
            const n = await node.syncWithPeer(RNS.fromHex(peerHex));
            if (n > 0) log(`RFed sync: ${n} blob(s) from ${peerHex}`);
          } catch (e) {
            log(`RFed sync with ${peerHex} failed: ${e.message}`);
          }
        }
      };
      // Initial sync after 5 seconds
      const _initialSync = setTimeout(syncOnce, 5000);
      // Periodic sync every 5 minutes
      const intervalMs = 5 * 60 * 1000;
      syncTimer = setInterval(syncOnce, intervalMs);
      log(`RFed syncing with ${peers.length} peer(s)`);
    }

    const teardown = () => {
      clearInterval(maintenanceTimer);
      if (syncTimer) clearInterval(syncTimer);
      if (node && typeof node.stop === "function") {
        node.stop();
      }
      // Final persist on shutdown
      if (dataDir) {
        Promise.resolve()
          .then(async () => {
            try {
              const rfedDataDir = `${dataDir}/rfed`;
              await deps.saveRFedStores(rfedDataDir, {
                blobStore: node.blobStore,
                subscriptions: node.subscriptions,
                deferred: node.deferred,
                notify: node.notifyRegistry,
              });
              log("RFed stores persisted on shutdown");
            } catch (e) {
              log(`RFed final persist failed: ${e.message}`);
            }
          })
          .catch(() => {});
      }
    };

    return { node, teardown };
  } catch (e) {
    log(`Failed to start embedded RFed federation node: ${e.message}`);
    return { node: null, teardown: () => {} };
  }
}

module.exports = {
  deps,
  setupEmbeddedPropagationNode,
  setupEmbeddedRFedNode,
};
