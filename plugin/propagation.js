/**
 * LXMF store-and-forward (propagation) *client* support.
 *
 * The node acts as a client of an external LXMF propagation node — it never
 * runs the propagation-node role itself (LXMF.md §5.3). Run a dedicated
 * propagation node (NomadNet, Sideband, rnsd, …) on the boat and point this
 * plugin at its `lxmf.propagation` destination hash.
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
 *  - **Sending** — {@link makeAutoDeliverer} prefers direct delivery (the
 *    opportunistic/link path alerts already use) and only falls back to
 *    {@link makePropagationDeliverer} (store-and-forward submit) when the
 *    recipient can't be reached right now — i.e. no path to their
 *    `lxmf.delivery` destination is known — mirroring Sideband's auto outbox
 *    mode. The message is then stored at the propagation node until the
 *    recipient next syncs.
 *
 * The transport classes are injected through {@link deps} (defaulting to the
 * real `@reticulum/core`) so this module can be unit-tested without network
 * I/O.
 *
 * @file propagation.js
 */

const RNS = require("@reticulum/core");
// LXMF moved out of the package root in @reticulum/core 0.6 — deep-import it.
const { LXMessage } = require("@reticulum/core/src/lxmf/index.js");
const {
  unpackPropagationContainer,
} = require("@reticulum/core/src/lxmf/propagation.js");

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
 * Builds a `deliver(destinationHashHex, title, content, linkId?)` callback that
 * submits a single LXMF message to the configured propagation node for
 * store-and-forward delivery (LXMF.md §5.8 / LXMessage PROPAGATED).
 *
 * The arrival `linkId` is accepted for signature parity with the direct
 * deliverer but ignored: a propagated message always travels over a fresh link
 * to the propagation node, never the link an inbound message arrived on.
 *
 * Rejects (and the caller logs and continues) when the propagation node is
 * unreachable or the recipient identity is unknown to the node.
 *
 * @param {object} lxmf - An initialised LXMRouter.
 * @param {object} identity - The sender Reticulum identity.
 * @param {(...args:any[])=>void} [debug] - Signal K `app.debug`-style logger.
 * @returns {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null)=>Promise<void>}
 */
function makePropagationDeliverer(lxmf, identity, debug = () => {}) {
  return async function deliverViaPropagation(
    destinationHashHex,
    title,
    content,
    /* linkId — ignored, see JSDoc */
  ) {
    const message = new deps.LXMessage({
      sourceHash: lxmf.deliveryDest.destinationHash,
      destinationHash: deps.fromHex(destinationHashHex),
      title,
      content,
    });
    const result = await lxmf.submitToPropagationNode(message, identity);
    debug(
      `LXMF message submitted to the propagation node for ${destinationHashHex}` +
        ` (stamp cost ${result.stampCost})`,
    );
  };
}

/**
 * Builds a `deliver` callback that prefers direct delivery and only falls back
 * to the propagation node when the recipient can't be reached right now — i.e.
 * no path to their `lxmf.delivery` destination is known (`transport.hasPath`
 * returns false), mirroring Sideband's auto outbox mode.
 *
 * When the recipient *is* reachable the direct deliverer runs (it itself does
 * link-then-opportunistic); when no path is known the message is submitted to
 * the propagation node so it is stored until the recipient next syncs. When no
 * path check is available (the transport lacks `hasPath`) direct delivery is
 * always used, preserving the pre-propagation behaviour.
 *
 * @param {object} options
 * @param {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null)=>Promise<void>} options.directDeliver
 * @param {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null)=>Promise<void>} options.propagationDeliver
 * @param {(destinationHash:Uint8Array)=>boolean} [options.hasPath]
 *   `rns.transport.hasPath` (or equivalent); when omitted the recipient is
 *   always assumed reachable so direct delivery is used.
 * @param {(hex:string)=>Uint8Array} [options.fromHex]
 * @param {(...args:any[])=>void} [options.debug]
 * @returns {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null)=>Promise<void>}
 */
function makeAutoDeliverer({
  directDeliver,
  propagationDeliver,
  hasPath,
  fromHex = deps.fromHex,
  debug = () => {},
}) {
  return async function deliverAuto(
    destinationHashHex,
    title,
    content,
    linkId,
  ) {
    const canCheck = typeof hasPath === "function";
    const reachable = !canCheck || hasPath(fromHex(destinationHashHex));
    if (reachable) {
      return directDeliver(destinationHashHex, title, content, linkId);
    }
    debug(
      `No path to ${destinationHashHex}; falling back to store-and-forward via the propagation node`,
    );
    return propagationDeliver(destinationHashHex, title, content, linkId);
  };
}

/**
 * Submits a message to an *embedded* propagation node in-process, bypassing
 * the link a remote {@link makePropagationDeliverer} establishes.
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

/**
 * Builds a `deliver(destinationHashHex, title, content, linkId?)` callback that
 * submits a single LXMF message to an *embedded* propagation node in-process
 * (the in-process counterpart to {@link makePropagationDeliverer}).
 *
 * Used by {@link makeAutoDeliverer} as the store-and-forward fallback when an
 * embedded propagation node is running: a reachable recipient still gets direct
 * delivery; an unreachable one has the message stored until they next sync.
 *
 * @param {object} lxmf - An initialised LXMRouter with propagation enabled.
 * @param {object} node - The embedded `PropagationNode` (`lxmf.propagationNode`).
 * @param {object} identity - The sender Reticulum identity.
 * @param {(...args:any[])=>void} [debug]
 * @returns {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null)=>Promise<void>}
 */
function makeEmbeddedPropagationDeliverer(
  lxmf,
  node,
  identity,
  debug = () => {},
) {
  return async function deliverViaEmbeddedPropagation(
    destinationHashHex,
    title,
    content,
    /* linkId — ignored, see makePropagationDeliverer */
  ) {
    const message = new deps.LXMessage({
      sourceHash: lxmf.deliveryDest.destinationHash,
      destinationHash: deps.fromHex(destinationHashHex),
      title,
      content,
    });
    await submitToEmbeddedNode(lxmf, node, message, identity, debug);
  };
}

module.exports = {
  deps,
  normalizeNodeHash,
  configurePropagationNode,
  syncFromNode,
  makePropagationDeliverer,
  makeAutoDeliverer,
  submitToEmbeddedNode,
  makeEmbeddedPropagationDeliverer,
};
