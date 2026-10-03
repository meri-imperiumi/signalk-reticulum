/**
 * Brings up the LXMF (Lightweight Extensible Message Format) router so the
 * Signal K node can send messages to crew members, and builds the delivery
 * callback used by the notification forwarding logic.
 *
 * The LXMF transport classes are injected through {@link deps} (defaulting to
 * the real `@reticulum/core`) so this module can be unit-tested without any
 * network I/O.
 *
 * Delivery escalates through the router's automated fallback ladder
 * (@reticulum/lxmf 0.9.3 `LXMRouter.send(message, identity, { fallback })`):
 * DIRECT link → opportunistic packet → store-and-forward via a propagation
 * node. When a propagation node is in use (the embedded in-plugin node, or an
 * external one configured/auto-discovered under `propagation`) every outbound
 * message — replies, alerts *and* telemetry — is submitted to it as the last
 * resort, mirroring pi-lxmf's delivery behaviour, so a message for an
 * unreachable peer is stored for them instead of silently dropped.
 *
 * @file messaging.js
 */

const RNS = require("@reticulum/core");
const { UnknownIdentityError } = require("@reticulum/core");
const { LXMRouter, LXMessage, LXMFConstants } = require("@reticulum/lxmf");

const { withAppearance } = require("./appearance");
const { submitToEmbeddedNode } = require("./propagation");

/** Injected transport classes; tests swap these for fakes. */
const deps = {
  LXMRouter,
  LXMessage,
  FIELD_TELEMETRY: LXMFConstants.FIELD_TELEMETRY,
  FIELD_ICON_APPEARANCE: LXMFConstants.FIELD_ICON_APPEARANCE,
  fromHex: RNS.fromHex,
  toHex: RNS.toHex,
};

/**
 * Per-attempt time budget handed to the router's delivery ladder: how long a
 * DIRECT link establishment or an opportunistic identity solicitation may
 * take before the router escalates to the next rung. Generous on purpose —
 * a peer may be several slow mesh hops away. Same value pi-lxmf uses.
 *
 * @type {number}
 */
const OUTBOUND_TIMEOUT_MS = 30_000;

/**
 * Whether `e` is one of the two failures the router's propagation handoff
 * (`send` escalation rung 3 / `submitToPropagationNode`) produces when it
 * *declines* instead of queueing:
 *
 *  - `Propagation node identity unknown for …` — the external node's announce
 *    has not been heard yet (fresh start), so its identity is not recallable
 *    and no link to it can be established.
 *  - `… no outbound propagation node is configured` — the router has no
 *    outbound node set, which happens when the in-plugin *embedded*
 *    propagation node is the store-and-forward target: its announce is never
 *    ingested in-process (loopback gap), so the link-based handoff is skipped
 *    entirely and the sender submits to the embedded node itself instead.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
function isPropagationHandoffError(e) {
  return (
    e instanceof Error &&
    /Propagation node identity unknown|no outbound propagation node is configured/.test(
      e.message,
    )
  );
}

/**
 * Builds the single outbound send function behind every LXMF deliverer
 * (replies, alerts, telemetry) — the pi-lxmf delivery pattern:
 *
 *  1. One `lxmf.send` call with the router's automated escalation
 *     (`fallback: "propagation"` when a propagation node is in use): DIRECT
 *     link → opportunistic packet (proof-settled; a stale path fails the
 *     proof wait and counts as a failure) → propagation handoff — all against
 *     one serialized message, so every wire copy shares one message id.
 *  2. When the router's propagation handoff *declines* instead of queueing
 *     ({@link isPropagationHandoffError}), the sender recovers exactly like
 *     pi-lxmf's `createRetrySender`:
 *     - **Embedded node** — submit to the in-plugin propagation node
 *       in-process ({@link module:propagation~submitToEmbeddedNode}), which
 *       stores the message for the recipient (or auto-delivers it locally).
 *     - **External node** — request a path and wait up to the timeout for the
 *       node's announce, then resend; the message keeps its message id across
 *       serializations, so wire-level dedup still holds.
 *
 * The embedded-node getter is late-bound: the embedded propagation node is
 * brought up after the LXMF router, so the sender re-evaluates it on every
 * send instead of capturing it once.
 *
 * @param {object} deps
 * @param {object} deps.lxmf - An initialised LXMRouter.
 * @param {object} deps.identity - The sender Reticulum identity.
 * @param {(msg: string) => void} [deps.debug] - Signal K `app.debug`-style logger.
 * @param {() => (object|null)} [deps.getEmbeddedNode] - Returns the embedded
 *   propagation node (`lxmf.propagationNode`-shaped, with `ingestBlobs`) when
 *   the in-plugin node is running, else null. Read at send time.
 * @param {number} [deps.timeoutMs] - Per-attempt time budget.
 * @returns {(message: object, options?: {linkId?: Uint8Array|null}) => Promise<void>}
 */
function makeOutboundSender({
  lxmf,
  identity,
  debug = () => {},
  getEmbeddedNode,
  timeoutMs = OUTBOUND_TIMEOUT_MS,
}) {
  return async function send(message, { linkId = null } = {}) {
    const embeddedNode =
      typeof getEmbeddedNode === "function" ? getEmbeddedNode() : null;
    const hasPropagationNode = !!(lxmf.outboundPropagationNode || embeddedNode);
    const options = {
      linkId,
      fallback: hasPropagationNode ? "propagation" : "opportunistic",
      timeoutMs,
    };
    try {
      await lxmf.send(message, identity, options);
      return;
    } catch (e) {
      if (!hasPropagationNode || !isPropagationHandoffError(e)) {
        throw e;
      }
      // Direct and opportunistic delivery both failed and the router's
      // propagation handoff declined instead of queueing. Recover so the
      // message is stored for the recipient rather than dropped.
      if (embeddedNode) {
        debug(
          "Direct delivery failed and the router cannot link to the embedded " +
            "propagation node in-process — submitting to it directly",
        );
        await submitToEmbeddedNode(
          lxmf,
          embeddedNode,
          message,
          identity,
          debug,
        );
        return;
      }
      const nodeHash = lxmf.outboundPropagationNode;
      debug(
        `Propagation node identity unknown — requesting path, waiting up to ` +
          `${Math.round(timeoutMs / 1000)}s for its announce`,
      );
      const transport = lxmf.rns?.transport;
      if (
        !transport ||
        typeof transport.recallOrSolicitIdentity !== "function"
      ) {
        throw e;
      }
      try {
        await transport.recallOrSolicitIdentity(nodeHash, timeoutMs);
      } catch (solicitError) {
        debug(
          `No announce from the propagation node in ${Math.round(
            timeoutMs / 1000,
          )}s — giving up`,
        );
        // Surface the original delivery failure, not the solicit timeout.
        if (
          (UnknownIdentityError &&
            solicitError instanceof UnknownIdentityError) ||
          solicitError.name === "UnknownIdentityError"
        ) {
          throw e;
        }
        throw solicitError;
      }
      await lxmf.send(message, identity, options);
      debug(
        "Recipient unreachable directly — submitted via the propagation node " +
          "(delivered on their next sync)",
      );
    }
  };
}

/**
 * Resolves the outbound-sender options shared by the deliverer builders:
 * `debug`, the late-bound embedded propagation node getter and the per-attempt
 * timeout. Accepts the legacy positional `debug` logger too, so callers can
 * pass either `makeDeliverer(lxmf, identity, { debug })` or a bare logger.
 *
 * @param {object|((msg:string)=>void)|undefined} options
 * @param {((msg:string)=>void)|undefined} [positionalDebug]
 * @returns {{debug: (msg: string) => void, getEmbeddedNode?: () => object|null, timeoutMs?: number}}
 */
function resolveSenderOptions(options, positionalDebug) {
  if (typeof options === "function") {
    return { debug: options };
  }
  const resolved = options || {};
  return {
    debug: resolved.debug || positionalDebug || (() => {}),
    ...(resolved.getEmbeddedNode
      ? { getEmbeddedNode: resolved.getEmbeddedNode }
      : {}),
    ...(resolved.timeoutMs ? { timeoutMs: resolved.timeoutMs } : {}),
  };
}

/**
 * Creates and initialises an LXMF router bound to `identity` on `rns`, then
 * announces the `lxmf.delivery` destination so peers learn who we are.
 *
 * The announcement is best-effort: a failure is logged but never thrown, as the
 * router remains usable for opportunistic delivery to crew whose identities are
 * already known.
 *
 * Forward-secrecy ratchets on the delivery destination are **kept enabled**
 * (the `LXMRouter.init()` default), exactly like the LXMF echobot. This is
 * not optional: peers such as NomadNet / Sideband learn our ratchet public
 * key from the announce and encrypt opportunistic inbound messages to it.
 * Disabling ratchets (as this code once did for announce-visibility reasons)
 * leaves us holding no ratchet private key, so `Identity.decrypt()` returns
 * null, the destination emits no PROOF, and the sender retransmits forever
 * with no acknowledgement or response — even though outbound traffic
 * (telemetry) still works. Keeping ratchets on ensures every ratchet-encrypted
 * inbound message decrypts and is acknowledged.
 *
 * @param {object} rns - A Reticulum instance (owns the transport/interfaces).
 * @param {object} identity - The sender Reticulum identity.
 * @param {{displayName?:string, announceIntervalMs?:number}} [options]
 *   When `announceIntervalMs` is a positive number the `lxmf.delivery`
 *   destination is periodically re-announced at that cadence (the first
 *   announce fires immediately) instead of announced once.
 * @param {(...args:any[])=>void} [log]
 * @returns {Promise<object>} The initialised LXMRouter (also exposes
 *   `deliveryDest.destinationHash`, the node's own LXMF address).
 */
async function setupMessaging(rns, identity, options = {}, log = () => {}) {
  const lxmf = new deps.LXMRouter(identity, rns);
  await lxmf.init();
  if (options.displayName) {
    try {
      const intervalMs =
        options.announceIntervalMs && options.announceIntervalMs > 0
          ? options.announceIntervalMs
          : null;
      if (intervalMs) {
        // startAnnouncing sets the app_data from the display name, fires the
        // first announce immediately, and repeats on the interval — so it
        // replaces the one-shot announce entirely.
        await lxmf.startAnnouncing(options.displayName, { intervalMs });
        log(
          `Announced LXMF destination ${deps.toHex(
            lxmf.deliveryDest.destinationHash,
          )} as "${options.displayName}" (re-announcing every ${
            Math.round((intervalMs / 1000) * 10) / 10
          }s)`,
        );
      } else {
        await lxmf.announce(options.displayName);
        log(
          `Announced LXMF destination ${deps.toHex(
            lxmf.deliveryDest.destinationHash,
          )} as "${options.displayName}"`,
        );
      }
    } catch (e) {
      log(`Failed to announce LXMF destination: ${e.message}`);
    }
  }
  return lxmf;
}

/**
 * Builds a `deliver(destinationHashHex, title, content, linkId?)` callback
 * bound to the given router and sender identity. Each call constructs and
 * sends a single LXMF message to the recipient's `lxmf.delivery` destination.
 *
 * Delivery rides the shared outbound sender ({@link makeOutboundSender}): the
 * router tries the supplied arrival link first and escalates — opportunistic
 * single packet when the link send fails (typically a battery-conscious
 * mobile client tore the link down right after its own message was
 * acknowledged), then store-and-forward via the propagation node when the
 * recipient can't be reached at all (LXMF.md §5.1/§5.8, the delivery ladder
 * @reticulum/lxmf 0.9.3 automates in `LXMRouter.send`). All of that happens
 * inside one `send` call against one serialized message, so every wire copy
 * of one reply shares one message id and a client that deduplicates by
 * message hash (Sideband, Nomad Network) renders the reply once even when a
 * fallback copy also arrives.
 *
 * Rejects if delivery fails on every rung; the caller (notification
 * forwarding) logs and continues with the next recipient.
 *
 * @param {object} lxmf - An initialised LXMRouter.
 * @param {object} identity - The sender Reticulum identity.
 * @param {object|((msg:string)=>void)} [options] - Outbound sender options
 *   (`debug`, `getEmbeddedNode`, `timeoutMs`) or, for convenience, a bare
 *   debug logger.
 * @returns {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null)=>Promise<object>}
 *   Resolves with the LXMessage that was sent.
 */
function makeDeliverer(lxmf, identity, options = {}) {
  const senderOptions = resolveSenderOptions(options);
  const sender = makeOutboundSender({ lxmf, identity, ...senderOptions });
  const debug = senderOptions.debug;
  return async function deliver(destinationHashHex, title, content, linkId) {
    const message = new deps.LXMessage({
      sourceHash: lxmf.deliveryDest.destinationHash,
      destinationHash: deps.fromHex(destinationHashHex),
      title,
      content,
    });
    await sender(message, { linkId });
    debug(
      `LXMF message delivered to ${destinationHashHex}${
        linkId ? " via the arrival link (or its fallback)" : ""
      }`,
    );
    return message;
  };
}

/**
 * Builds a `deliverTelemetry(destinationHashHex, packedTelemetry)` callback
 * bound to the given router and sender identity. Each call constructs and sends
 * a single LXMF message carrying the Sideband telemetry snapshot in its
 * `FIELD_TELEMETRY` field (with empty title/content), so any LXMF client that
 * understands telemetry — Sideband, NomadNet, MeshChat — renders it in the
 * peer's telemetry view.
 *
 * The `fields` map uses an integer key (via `Map`) so it is serialised with an
 * integer field id on the wire, exactly as Sideband expects.
 *
 * When an `appearance` (icon + colors) is supplied it is merged into the same
 * message's `FIELD_ICON_APPEARANCE` field, so peers render the boat's avatar
 * alongside the telemetry — the same coupling Sideband uses
 * (`telemetry_send_appearance`). See `appearance.js` for the wire shape.
 *
 * Rejects if the recipient's identity is unknown or delivery fails; the caller
 * logs and continues with the next recipient.
 *
 * @param {object} lxmf - An initialised LXMRouter.
 * @param {object} identity - The sender Reticulum identity.
 * @param {{icon?:string, fg?:[number,number,number], bg?:[number,number,number]}|null} [appearance]
 *   Resolved node appearance to advertise with each telemetry message.
 * @param {object} [options] - Outbound sender options (`debug`,
 *   `getEmbeddedNode`, `timeoutMs`) shared with {@link makeDeliverer}.
 * @returns {(destinationHashHex:string, packedTelemetry:Uint8Array)=>Promise<void>}
 */
function makeTelemetryDeliverer(lxmf, identity, appearance, options = {}) {
  const sender = makeOutboundSender({
    lxmf,
    identity,
    ...resolveSenderOptions(options),
  });
  return async function deliverTelemetry(destinationHashHex, packedTelemetry) {
    const base = new Map([[deps.FIELD_TELEMETRY, packedTelemetry]]);
    const fields = withAppearance(base, appearance, deps.FIELD_ICON_APPEARANCE);
    const message = new deps.LXMessage({
      sourceHash: lxmf.deliveryDest.destinationHash,
      destinationHash: deps.fromHex(destinationHashHex),
      title: "",
      content: "",
      fields,
    });
    await sender(message);
  };
}

/**
 * Attaches Signal K logging to the inbound LXMF choke points so an operator
 * can follow a peer's message through the router — packet decrypted → sender
 * identity known or unknown → dispatched — without having to enable RNS's
 * own DEBUG console output, which bypasses `app.debug`.
 *
 * The `lxmf.delivery` destination emits a `"data"` event for every
 * opportunistic (single-packet) inbound message the instant it decrypts
 * (which is also when it sends the packet PROOF). At that point we parse just
 * the source hash and report whether we can already recall the sender's
 * identity: when it is UNKNOWN the router parks the message and solicits a
 * path/announce, and the message is only dispatched once that announce
 * arrives — the most common reason a peer sees a proof but the plugin never
 * logs `Received LXMF message`. A `"peer"` event is emitted whenever a peer
 * announce (or inbound-link LINKIDENTIFY) makes an identity available, so a
 * parked message can be correlated with the announce that released it.
 *
 * @param {object} lxmf - An initialised LXMRouter.
 * @param {(...args:any[])=>void} [debug] - Signal K `app.debug`-style logger.
 * @returns {() => void} unsubscribe — removes both listeners.
 */
function attachInboundDiagnostics(lxmf, debug = () => {}) {
  const onData = async (event) => {
    const plaintext = event && event.detail && event.detail.plaintext;
    if (!plaintext) return;
    try {
      const parsed = await deps.LXMessage.deserialize(
        plaintext,
        lxmf.deliveryDest.destinationHash,
      );
      const known = await lxmf.rns.transport.recallIdentity(parsed.sourceHash);
      debug(
        `Inbound LXMF data packet from ${deps.toHex(
          parsed.sourceHash || [],
        )} (${plaintext.length} bytes); sender identity ${
          known
            ? "known"
            : "UNKNOWN - message parked until announce/path arrives"
        }`,
      );
    } catch (e) {
      debug(
        `Inbound LXMF data packet (${plaintext.length} bytes) could not be parsed: ${e.message}`,
      );
    }
  };
  lxmf.deliveryDest.addEventListener("data", onData);

  const onPeer = (event) => {
    const destinationHash =
      event && event.detail && event.detail.destinationHash;
    if (destinationHash) {
      debug(
        `Learned LXMF peer ${deps.toHex(
          destinationHash,
        )} (announce/identity received)`,
      );
    }
  };
  lxmf.addEventListener("peer", onPeer);

  return () => {
    try {
      lxmf.deliveryDest.removeEventListener("data", onData);
    } catch {
      /* best effort */
    }
    try {
      lxmf.removeEventListener("peer", onPeer);
    } catch {
      /* best effort */
    }
  };
}

/**
 * Verifies the signature of an inbound LXMF message against the sender's
 * recalled identity, closing the propagation-sync verification gap.
 *
 * The router signature-verifies on the direct-delivery path (it parks a
 * message until the sender's identity is known, then checks the signature
 * before dispatching), but a message pulled in via a propagation-node sync —
 * or ingested from a paper `lxm://` URI — is dispatched *without* verification
 * when the sender's identity is not yet recalled (mirroring Python's
 * `SOURCE_UNKNOWN` handling). A source-hash check alone is forgeable on those
 * paths (a 16-byte hash, no private key needed), so callers must not rely on
 * the router for this: a message is admitted only when this returns
 * `"verified"`.
 *
 * @param {object} lxmf - An initialised LXMRouter.
 * @param {object} message - The inbound LXMessage.
 * @returns {Promise<"verified"|"unknown"|"invalid">}
 *   `"verified"` — signature checks against the recalled sender identity.
 *   `"unknown"`   — sender identity not recalled yet; a path/announce is
 *                  requested so later copies can be verified, but this copy
 *                  must be treated as unverified.
 *   `"invalid"`   — signature failed cryptographic proof.
 */
async function verifySender(lxmf, message) {
  const sender = await lxmf.rns.transport.recallIdentity(message.sourceHash);
  if (!sender) {
    // Solicit the sender's announce (the same request the router makes for a
    // parked direct message), so the identity lands and a later copy of this
    // message — a retry, or another sync — verifies.
    try {
      if (typeof lxmf.rns.transport.requestPath === "function") {
        await lxmf.rns.transport.requestPath(message.sourceHash);
      }
    } catch {
      /* best effort */
    }
    return "unknown";
  }
  return (await message.verifySignature(sender)) ? "verified" : "invalid";
}

module.exports = {
  deps,
  OUTBOUND_TIMEOUT_MS,
  setupMessaging,
  isPropagationHandoffError,
  makeOutboundSender,
  makeDeliverer,
  makeTelemetryDeliverer,
  attachInboundDiagnostics,
  verifySender,
};
