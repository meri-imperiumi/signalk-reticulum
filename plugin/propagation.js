/**
 * LXMF store-and-forward (propagation) *client* support.
 *
 * The node acts as a client of an LXMF propagation node — it never runs the
 * propagation-node role itself (LXMF.md §5.3). Run a dedicated propagation
 * node (NomadNet, Sideband, rnsd, …) on the boat and point this plugin at its
 * `lxmf.propagation` destination hash.
 *
 * Two directions are wired up:
 *
 *  - **Receiving** — {@link syncFromNode} pulls messages the propagation node
 *    is holding addressed to this node and feeds them back through the router,
 *    so they dispatch through the same `message` event as direct messages and
 *    reach the existing command handler unchanged. This is how messages sent
 *    to the boat while it was offline (no mesh path) are delivered once it
 *    syncs from the node.
 *
 *  - **Sending** — the router's own escalation ladder handles it
 *    (`LXMRouter.send` with `fallback: "propagation"`, driven by
 *    `messaging.makeOutboundSender`): when a recipient can't be reached
 *    directly the message is submitted to the configured external node via
 *    `submitToPropagationNode`, or to the embedded in-plugin node via
 *    {@link submitToEmbeddedNode} (the link-based submit cannot reach a local
 *    destination). The message is then stored until the recipient next syncs.
 *
 * The transport classes are injected through {@link deps} (defaulting to the
 * real `@reticulum/core`) so this module can be unit-tested without network
 * I/O.
 *
 * @file propagation.js
 */

const RNS = require("@reticulum/core");
const { LXMessage, unpackPropagationContainer } = require("@reticulum/lxmf");

/** Injected transport classes; tests swap these for fakes. */
const deps = {
  LXMessage,
  fromHex: RNS.fromHex,
  toHex: RNS.toHex,
};

/** Matches a canonical 16-byte LXMF destination hash (32 lowercase hex chars). */
const DESTINATION_HASH_RE = /^[0-9a-f]{32}$/;

/**
 * Normalises and validates a propagation-node destination hash: trims,
 * lower-cases, strips the whitespace/dashes parsers tolerate, and returns the
 * 32-hex hash — or `""` when the value is missing or not a valid hash.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeNodeHash(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const hex = raw.trim().toLowerCase().replace(/[\s-]/g, "");
  return DESTINATION_HASH_RE.test(hex) ? hex : "";
}

/**
 * Configures `lxmf` to use the propagation node `nodeHex` as its outbound
 * store-and-forward node by calling `setOutboundPropagationNode`
 * (LXMF.md §5.8). Safe to call before the node has announced: its identity and
 * path are recalled lazily on the first submit/sync.
 *
 * @param {object} lxmf - An initialised LXMRouter.
 * @param {string} nodeHex - The propagation node's 32-hex destination hash.
 * @param {(...args:any[])=>void} [log]
 * @returns {boolean} whether the node was configured.
 */
function configurePropagationNode(lxmf, nodeHex, log = () => {}) {
  if (!lxmf || !nodeHex) {
    return false;
  }
  try {
    lxmf.setOutboundPropagationNode(deps.fromHex(nodeHex));
    log(`Configured LXMF propagation node ${nodeHex} for store-and-forward`);
    return true;
  } catch (e) {
    log(`Failed to configure propagation node: ${e.message}`);
    return false;
  }
}

/**
 * Pulls messages addressed to `identity` from the configured propagation node
 * (LXMF.md §5.8.1). Each synced message decrypts and dispatches through the
 * router's normal `message` event, so it reaches the existing command handler
 * exactly like a direct one.
 *
 * Errors are logged and never thrown — a failed sync (the node unreachable, or
 * its identity not yet learned from an announce) is simply retried on the next
 * interval. Returns the router's `{received, duplicates}` counts, defaulting
 * both to zero on failure.
 *
 * @param {object} lxmf - An initialised LXMRouter with an outbound propagation
 *   node configured.
 * @param {object} identity - The recipient Reticulum identity to identify as.
 * @param {(...args:any[])=>void} [log]
 * @returns {Promise<{received:number, duplicates:number}>}
 */
async function syncFromNode(lxmf, identity, log = () => {}) {
  try {
    const result = await lxmf.syncFromPropagationNode(identity);
    const received = result ? result.received || 0 : 0;
    const duplicates = result ? result.duplicates || 0 : 0;
    if (received > 0) {
      log(
        `LXMF propagation sync received ${received} message(s)` +
          (duplicates ? `, ${duplicates} duplicate` : ""),
      );
    }
    return { received, duplicates };
  } catch (e) {
    log(`LXMF propagation sync failed: ${e.message}`);
    return { received: 0, duplicates: 0 };
  }
}

/**
 * Submits a message to an *embedded* propagation node in-process, bypassing
 * the link-based `submitToPropagationNode` the router uses for external nodes.
 *
 * When the plugin runs its own propagation node, the node and its client
 * share one Reticulum instance and identity. A link-based
 * `submitToPropagationNode` cannot reach the local `lxmf.propagation`
 * destination (the node's own announce is never ingested, so its identity is
 * never recallable, and an outbound packet to a local destination has no
 * path) — the same in-process loopback gap the embedded RFed fix addresses.
 *
 * The message is packed with the router's canonical `_packForPropagationSubmit`
 * (identical wire format to a remote submit: encrypted to the recipient,
 * stamp appended), then the resulting blob is handed directly to
 * `node.ingestBlobs`. The node stores it for a remote recipient (so other
 * boats' LXMRouters can sync it) or auto-delivers it via `onLocalDelivery` if
 * addressed to this node. The embedded node therefore behaves exactly like a
 * regular propagation node to everything on the mesh.
 *
 * The stamp is generated at the node's configured `stampCost` (the same cost a
 * remote submitter must meet); for a trusted local submit this is trivial PoW
 * at alert cadence and keeps the node's stamp accounting consistent.
 *
 * @param {object} lxmf - An initialised LXMRouter with propagation enabled.
 * @param {object} node - The embedded `PropagationNode` (`lxmf.propagationNode`).
 * @param {object} message - An `LXMessage` ready for propagation.
 * @param {object} senderIdentity - The sender Reticulum identity.
 * @param {(...args:any[])=>void} [log]
 * @returns {Promise<{transientId: Uint8Array, stampCost: number}>}
 */
async function submitToEmbeddedNode(lxmf, node, message, senderIdentity, log) {
  const debug = typeof log === "function" ? log : () => {};
  if (!lxmf || !node) {
    throw new Error("Embedded propagation node not available.");
  }
  // Read the stamp cost directly from the node (no recall/link needed).
  const stampCost = node.stampCost ?? 0;
  // Pack into the propagation container — identical bytes to a remote submit.
  const { container, transientId } = await lxmf._packForPropagationSubmit(
    message,
    senderIdentity,
    stampCost,
  );
  // Unpack to the individual stamped blobs the node ingests (the link handler
  // does the same on the receiving end of a Resource transfer).
  const { messages } = unpackPropagationContainer(container);
  const result = await node.ingestBlobs(messages);
  debug(
    `LXMF message submitted to the embedded propagation node ` +
      `(${result.stored} stored, ${result.delivered} delivered, ` +
      `${result.rejected} rejected, stamp cost ${stampCost})`,
  );
  return { transientId, stampCost };
}

module.exports = {
  deps,
  normalizeNodeHash,
  configurePropagationNode,
  syncFromNode,
  submitToEmbeddedNode,
};
