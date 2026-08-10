/**
 * Triggers an immediate, manual re-announce of every destination the plugin
 * has brought up (the `lxmf.delivery` router and the `nomadnetwork.node`
 * destination, whichever exist) so peers rediscover the node right away —
 * without waiting for the next periodic re-announce.
 *
 * Used to react to a connectivity change (e.g. the Starlink internet link
 * going up or down): the boat's *internet* path may have appeared or vanished,
 * but the Reticulum mesh paths (radio, serial, LAN peering) are unaffected, so
 * a fresh announce lets clients switch over to a working, non-internet-based
 * route immediately instead of waiting up to the re-announce interval.
 *
 * Each destination is announced best-effort: a failure is logged and does not
 * abort the remaining destinations, mirroring how notification forwarding
 * treats per-recipient delivery.
 *
 * This module is intentionally free of any Signal K coupling so it can be
 * unit-tested in isolation; the caller decides *when* to trigger (e.g. on a
 * `network.providers.starlink.status` change) and passes the live destination
 * handles in.
 *
 * @file announce.js
 */

/**
 * Re-announces every active destination.
 *
 * The LXMF delivery destination is re-announced through the router's public
 * `announce(displayName)` (which rebuilds the §4.3 app_data and re-broadcasts)
 * so the announce carries the same name as the periodic loop. The NomadNet
 * node destination is re-announced directly via its `Destination.announce()`,
 * reusing the app_data already attached at setup. Both are fire-and-forget:
 * a thrown error is logged and the next destination is still attempted.
 *
 * @param {object} [handles]
 * @param {object} [handles.lxmf] - An initialised LXMRouter (the one returned
 *   by {@link setupMessaging}), or null/undefined when messaging did not come
 *   up. Re-announced via `lxmf.announce(displayName)`.
 * @param {string} [handles.displayName] - Display name to re-announce the
 *   LXMF destination with (the same one the periodic loop uses). When empty
 *   the LXMF destination is skipped, matching {@link setupMessaging}'s
 *   "only announce with a name" guard.
 * @param {{destination?:{announce:(()=>Promise<void>)|(()=>void)}}} [handles.nomadnet]
 *   - The NomadNet site handle (as returned by {@link setupNomadNet}), or
 *   null/undefined when the site is disabled. Re-announced via
 *   `nomadnet.destination.announce()`.
 * @param {{deliveryDest?:{announce:(()=>Promise<void>)|(()=>void)}}} [handles.rfed]
 *   - The external RFed client (as returned by {@link setupRFed}), or
 *   null/undefined when RFed runs embedded or is disabled. Re-announced via
 *   `rfed.deliveryDest.announce()` so the federation node keeps treating us
 *   as a live subscriber.
 * @param {{announce:(()=>Promise<void>)|(()=>void)}} [handles.embeddedRfed]
 *   - The embedded RFed federation node (as returned by {@link
 *   setupEmbeddedRFedNode}), or null/undefined when none is running.
 *   Re-announced via `node.announce()` (announces `rfed.node` + all service
 *   destinations).
 * @param {{announcePropagationNode:(()=>Promise<void>)|(()=>void)}} [handles.propagationLxmf]
 *   - The LXMRouter running an embedded propagation node, or null/undefined
 *   when none is running. Re-announced via
 *   `lxmf.announcePropagationNode()`.
 * @param {(...args:any[])=>void} [log] - Signal K `app.debug`-style logger
 *   used to record each re-announce outcome.
 * @returns {Promise<number>} The number of destinations re-announced.
 */
async function triggerAnnounce(
  { lxmf, displayName, nomadnet, rfed, embeddedRfed, propagationLxmf } = {},
  log,
) {
  const debug = typeof log === "function" ? log : () => {};
  let announced = 0;

  if (lxmf && displayName) {
    try {
      await lxmf.announce(displayName);
      announced += 1;
      debug(
        `Re-announced lxmf.delivery destination as "${displayName}" (connectivity trigger)`,
      );
    } catch (e) {
      debug(`Failed to re-announce lxmf.delivery: ${e.message}`);
    }
  }

  const nodeDest = nomadnet && nomadnet.destination;
  if (nodeDest && typeof nodeDest.announce === "function") {
    try {
      await nodeDest.announce();
      announced += 1;
      debug(
        "Re-announced nomadnetwork.node destination (connectivity trigger)",
      );
    } catch (e) {
      debug(`Failed to re-announce nomadnetwork.node: ${e.message}`);
    }
  }

  const rfedDelivery = rfed && rfed.deliveryDest;
  if (rfedDelivery && typeof rfedDelivery.announce === "function") {
    try {
      await rfedDelivery.announce();
      announced += 1;
      debug("Re-announced rfed.delivery destination (connectivity trigger)");
    } catch (e) {
      debug(`Failed to re-announce rfed.delivery: ${e.message}`);
    }
  }

  if (embeddedRfed && typeof embeddedRfed.announce === "function") {
    try {
      await embeddedRfed.announce();
      announced += 1;
      debug(
        "Re-announced embedded rfed federation node destinations (connectivity trigger)",
      );
    } catch (e) {
      debug(`Failed to re-announce embedded rfed node: ${e.message}`);
    }
  }

  if (
    propagationLxmf &&
    typeof propagationLxmf.announcePropagationNode === "function"
  ) {
    try {
      await propagationLxmf.announcePropagationNode();
      announced += 1;
      debug("Re-announced lxmf.propagation destination (connectivity trigger)");
    } catch (e) {
      debug(`Failed to re-announce lxmf.propagation: ${e.message}`);
    }
  }

  return announced;
}

module.exports = { triggerAnnounce };
