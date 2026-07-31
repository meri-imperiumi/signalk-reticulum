/**
 * Brings up the LXMF (Lightweight Extensible Message Format) router so the
 * Signal K node can send messages to crew members, and builds the delivery
 * callback used by the notification forwarding logic.
 *
 * The LXMF transport classes are injected through {@link deps} (defaulting to
 * the real `@reticulum/core`) so this module can be unit-tested without any
 * network I/O.
 *
 * Delivery is opportunistic by default: each message is sent as a single
 * encrypted packet addressed to the recipient's `lxmf.delivery` destination
 * hash, which requires the recipient's identity to be known (learned from an
 * announce). Store-and-forward via a propagation node is a future enhancement.
 *
 * @file messaging.js
 */

const RNS = require("@reticulum/core");

const { withAppearance } = require("./appearance");

/** Injected transport classes; tests swap these for fakes. */
const deps = {
  LXMRouter: RNS.LXMRouter,
  LXMessage: RNS.LXMessage,
  Destination: RNS.Destination,
  FIELD_TELEMETRY: RNS.LXMFConstants.FIELD_TELEMETRY,
  FIELD_ICON_APPEARANCE: RNS.LXMFConstants.FIELD_ICON_APPEARANCE,
  fromHex: RNS.fromHex,
  toHex: RNS.toHex,
};

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
 * When `linkId` is supplied the message is first tried over that already-
 * established Link (the prompt path the LXMF echobot uses). If that link send
 * fails — most importantly when a battery-conscious mobile client tears the
 * link down right after its own message is acknowledged, so the link is gone
 * by the time we reply — the reply falls back to opportunistic single-packet
 * delivery (LXMF.md §5.1). That is the same path telemetry and alerts already
 * use to reach these clients reliably, so a reply never goes missing just
 * because the arrival link did not stay open. Without a `linkId` (e.g.
 * notification forwarding, or an opportunistic inbound message) the reply is
 * sent opportunistically directly.
 *
 * Rejects if the recipient's identity is unknown or delivery fails; the caller
 * (notification forwarding) logs and continues with the next recipient.
 *
 * @param {object} lxmf - An initialised LXMRouter.
 * @param {object} identity - The sender Reticulum identity.
 * @param {(...args:any[])=>void} [debug] - Signal K `app.debug`-style logger
 *   used to record each delivery outcome (link, opportunistic, or fallback).
 * @returns {(destinationHashHex:string, title:string, content:string, linkId?:Uint8Array|null)=>Promise<void>}
 */
function makeDeliverer(lxmf, identity, debug = () => {}) {
  return async function deliver(destinationHashHex, title, content, linkId) {
    const build = () =>
      new deps.LXMessage({
        sourceHash: lxmf.deliveryDest.destinationHash,
        destinationHash: deps.fromHex(destinationHashHex),
        title,
        content,
      });
    try {
      await lxmf.send(build(), identity, linkId);
      debug(
        `LXMF message delivered to ${destinationHashHex}${
          linkId ? " via the arrival link" : " (opportunistic)"
        }`,
      );
    } catch (e) {
      // No arrival link to fall back from — propagate the error.
      if (!linkId) throw e;
      // The link reply failed (typically the peer closed the link after its
      // message was acknowledged). Retry as an opportunistic single packet —
      // the delivery path telemetry/alerts already use to reach these peers.
      debug(
        `LXMF link reply to ${destinationHashHex} failed (${e.message}); retrying opportunistic`,
      );
      await lxmf.send(build(), identity, null);
      debug(
        `LXMF message delivered to ${destinationHashHex} (opportunistic fallback)`,
      );
    }
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
 * @returns {(destinationHashHex:string, packedTelemetry:Uint8Array)=>Promise<void>}
 */
function makeTelemetryDeliverer(lxmf, identity, appearance) {
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
    await lxmf.send(message, identity);
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
      const known = await deps.Destination.recall(parsed.sourceHash);
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

module.exports = {
  deps,
  setupMessaging,
  makeDeliverer,
  makeTelemetryDeliverer,
  attachInboundDiagnostics,
};
