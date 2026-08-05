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

module.exports = {
  deps,
  normalizeNodeHash,
  configurePropagationNode,
  syncFromNode,
  makePropagationDeliverer,
  makeAutoDeliverer,
};
