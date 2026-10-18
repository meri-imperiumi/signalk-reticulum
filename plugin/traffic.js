/**
 * Metered-internet traffic throttling.
 *
 * The boat's embedded LXMF propagation node and RFed federation node serve
 * every mesh client unconditionally. When the boat's internet uplink is
 * metered (pay-per-GB Starlink, capped LTE), relaying 3rd-party propagation
 * and federation traffic through the boat costs real bandwidth. This module
 * provides the groundwork for limiting that:
 *
 *  - **Internet-state detection** — the unified internet connectivity state
 *    is published by the signalk-internet plugin on `network.internet.state`
 *    (`online` / `metered` / `offline` / `captive`). {@link isMeteredState}
 *    decides which of those values count as metered.
 *
 *  - **The known-boat allow list** — {@link effectiveKnownHashes} resolves
 *    every `lxmf.delivery` destination hash that counts as the boat's *own*
 *    traffic: the boat's own, every configured crew node's (derived from the
 *    crew configuration), plus any operator-configured extras. Everything
 *    else on the mesh is 3rd-party traffic.
 *
 *  - **The metered boundary tracker** — {@link createMeteredTracker} observes
 *    raw `network.internet.state` values and reports only *committed*
 *    metered↔unmetered transitions, after a hysteresis window, so a flapping
 *    connection never churns the throttling mode.
 *
 *  - **Policy application** — {@link applyMeteredPolicy} applies the metered
 *    lever to the live embedded propagation node, in place: the
 *    `ingestFilter` hook (@reticulum 0.9.13, reticulum-js work doc #47)
 *    drops *mirrored* propagation blobs — offer-born peer-sync copies —
 *    whose recipient is not a known-boat `lxmf.delivery` destination. The
 *    hook is read per call, so the flip takes effect immediately without a
 *    node restart.
 *
 * Everything is pure and injected-deps tested; only {@link applyMeteredPolicy}
 * touches live node objects.
 *
 * @file traffic.js
 */

const { toHex } = require("@reticulum/core");
const { deriveLxmfDestinationHash } = require("./identity");
const { effectiveCrew } = require("./notifications");

/** Injected helpers; tests swap these for fakes. */
const deps = {
  toHex,
  deriveLxmfDestinationHash,
};

/** The Signal K path carrying the unified internet connectivity state. */
const INTERNET_STATE_PATH = "network.internet.state";

/** The `network.internet.state` value meaning the connection is metered. */
const METERED_STATE = "metered";

/** Matches a canonical 16-byte Reticulum destination hash. */
const KNOWN_HASH_RE = /^[0-9a-f]{32}$/;

/**
 * Hysteresis window the new metered-ness must hold before a boundary flip is
 * committed. A flapping connection (Starlink plan polling, LTE metering
 * wobble) never churns the throttling mode on the live nodes.
 */
const METERED_GRACE_MS = 30_000;

/**
 * Normalises a raw internet-state value into a comparable lowercase state
 * string: `{value}` Signal K update wrappers are unwrapped, strings are
 * trimmed and lower-cased; anything absent/empty is `null`.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeInternetState(raw) {
  if (raw && typeof raw === "object" && "value" in raw) {
    raw = raw.value;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const state = raw.trim().toLowerCase();
  return state || null;
}

/**
 * Whether an internet state means the connection is metered (a cost- or
 * volume-limited uplink the boat should not relay 3rd-party traffic over).
 * Only the explicit `metered` value counts: `captive` and `offline` are not
 * internet uplinks at all, and `online` is an unmetered one.
 *
 * @param {string|null|undefined} state - A {@link normalizeInternetState} value.
 * @returns {boolean}
 */
function isMeteredState(state) {
  return state === METERED_STATE;
}

/**
 * Normalises a raw list of destination hashes into validated, lower-cased,
 * de-duplicated 32-hex strings. Entries that are missing or not valid hashes
 * are skipped (optionally logged); the rest pass through.
 *
 * @param {unknown} raw
 * @param {(...args:any[])=>void} [log] - Called for each skipped entry.
 * @returns {string[]}
 */
function normalizeHashList(raw, log = () => {}) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const hex = entry.trim().toLowerCase().replace(/[\s-]/g, "");
    if (!KNOWN_HASH_RE.test(hex)) {
      if (entry.trim()) {
        log(`Ignoring invalid destination hash "${entry}" in a known list`);
      }
      continue;
    }
    if (seen.has(hex)) {
      continue;
    }
    seen.add(hex);
    result.push(hex);
  }
  return result;
}

/**
 * Resolves every `lxmf.delivery` destination hash that counts as the boat's
 * *own* traffic — the complement of "3rd-party".
 *
 * Includes the boat's own derived `lxmf.delivery` destination hash, every
 * configured crew node's `lxmf.delivery` destination hash (derived from
 * their identity hashes, or used verbatim for legacy destination-only crew
 * entries), and the operator-configured `traffic_limits.known_nodes` extras
 * (e.g. additional boat-owned nodes not in the crew list).
 *
 * This is the recipient allow list the mirrored-traffic `ingestFilter` gate
 * (and future per-identity RFed gates) match against.
 *
 * @param {object|undefined} config - Plugin configuration.
 * @param {string|undefined} ownIdentityHashHex - This node's own 32-hex
 *   identity hash; absent on a not-yet-resolved identity.
 * @param {(...args:any[])=>void} [log]
 * @returns {string[]}
 */
function effectiveKnownHashes(config, ownIdentityHashHex, log = () => {}) {
  const seen = new Set();
  const result = [];
  const push = (hex) => {
    if (hex && !seen.has(hex)) {
      seen.add(hex);
      result.push(hex);
    }
  };

  if (typeof ownIdentityHashHex === "string") {
    push(deps.deriveLxmfDestinationHash(ownIdentityHashHex.toLowerCase()));
  }

  for (const member of effectiveCrew(config && config.crew, log)) {
    push(member.destinationHash);
  }

  for (const extra of normalizeHashList(
    config && config.traffic_limits && config.traffic_limits.known_nodes,
    log,
  )) {
    push(extra);
  }

  return result;
}

/**
 * Resolves the throttling policy for a given metered state: whether 3rd-party
 * traffic should be throttled right now, and which destination hashes count
 * as the boat's own. The throttle setting defaults to *enabled*; an explicit
 * `false` turns it off (the node then serves everyone regardless of the
 * metered state).
 *
 * The known list is the recipient allow list the mirrored-traffic
 * `ingestFilter` gate matches against — boat/crew `lxmf.delivery`
 * destination hashes, so crew-addressed messages keep flowing in from peers
 * even while 3rd-party mirroring is throttled (reticulum-js work doc #47).
 *
 * @param {object|undefined} config - Plugin configuration.
 * @param {boolean} metered - Whether the internet connection is metered.
 * @param {string|undefined} ownIdentityHashHex - This node's own identity hash.
 * @param {(...args:any[])=>void} [log]
 * @returns {{metered: boolean, throttleThirdParty: boolean, knownHashes: string[]}}
 */
function trafficPolicy(config, metered, ownIdentityHashHex, log = () => {}) {
  const limits = config && config.traffic_limits ? config.traffic_limits : {};
  const enabled = limits.throttle_third_party_metered !== false;
  return {
    metered,
    throttleThirdParty: metered && enabled,
    knownHashes: effectiveKnownHashes(config, ownIdentityHashHex, log),
  };
}

/**
 * Builds the `ingestFilter` gate for an embedded LXMF propagation node in
 * metered-throttle mode: only *mirrored* blobs (offer-born peer-sync copies)
 * addressed to a known-boat `lxmf.delivery` destination are stored — 3rd-party
 * traffic being relayed through the boat is dropped. Direct submissions are
 * always kept by the node itself (the filter is only consulted for
 * peer-sync mirrors), so the boat's own store-and-forward keeps working, and
 * peers' offers of crew-addressed messages keep flowing in.
 *
 * @param {string[]} knownHashes - Known-boat `lxmf.delivery` destination
 *   hashes ({@link effectiveKnownHashes}).
 * @returns {(candidate: {destinationHash:Uint8Array}) => boolean}
 */
function makeThrottledIngestFilter(knownHashes) {
  const knownSet = new Set(knownHashes);
  return (candidate) => {
    const hashBytes = candidate && candidate.destinationHash;
    if (!hashBytes) {
      return false;
    }
    return knownSet.has(deps.toHex(hashBytes));
  };
}

/**
 * Applies a traffic policy to the live embedded nodes, in place.
 *
 * The embedded LXMF propagation node's `ingestFilter` is the metered lever
 * (@reticulum 0.9.13, reticulum-js work doc #47; read per call, so flipping
 * takes effect immediately): when throttling, mirrored blobs — offer-born
 * peer-sync copies — are stored only when addressed to a known-boat
 * `lxmf.delivery` destination; 3rd-party traffic being relayed through the
 * boat is dropped. Direct submissions are always kept by the node itself
 * (it is their origin custodian; dropping one would destroy the sender's
 * message), and dropped mirrors are never re-pulled (the `/offer` want-list
 * remembers drops). When not throttling, the filter is removed and the node
 * stores everything again.
 *
 * The node's `identityAllowed` gate is deliberately left open: a stranger
 * peer's offer may carry crew-addressed messages (store-and-forward both
 * sides, per work doc #47's deployment constraints), and refusing `/get`
 * retrieval to strangers would strand messages this node holds as their
 * custodian — the black-hole design the work doc rejected.
 *
 * The embedded RFed federation node has no per-identity gate in the current
 * `@reticulum/rfed` release, so it is only flagged here — the next
 * reticulum-js release's RFed levers plug into this same hook.
 *
 * Idempotent: re-applying the same policy is a no-op besides logging.
 *
 * @param {object} options
 * @param {object} [options.lxmf] - The LXMF router (may be absent/teared down).
 * @param {object} [options.rfed] - The embedded RFed federation node.
 * @param {{metered: boolean, throttleThirdParty: boolean, knownHashes: string[]}} options.policy
 * @param {(...args:any[])=>void} [options.log]
 */
function applyMeteredPolicy({ lxmf, rfed, policy, log = () => {} }) {
  if (!policy) {
    return;
  }
  const propNode = lxmf && lxmf.propagationNode;
  if (propNode) {
    propNode.ingestFilter = policy.throttleThirdParty
      ? makeThrottledIngestFilter(policy.knownHashes)
      : null;
    if (policy.throttleThirdParty) {
      log(
        `Metered internet: embedded LXMF propagation node dropping ` +
          `mirrored 3rd-party traffic (only ${policy.knownHashes.length} ` +
          `known-boat destinations mirrored)`,
      );
    } else {
      log(
        "Unmetered internet: embedded LXMF propagation node mirroring everything again",
      );
    }
  }
  if (rfed && policy.throttleThirdParty) {
    log(
      "Metered internet: no per-identity RFed throttle lever in the current " +
        "@reticulum/rfed; publish/subscribe gating awaits the library levers",
    );
  }
}

/**
 * Builds a metered-state tracker: observes raw `network.internet.state`
 * values and commits only real metered↔unmetered transitions, each after a
 * hysteresis window during which the new metered-ness must hold. A flip back
 * within the window cancels the pending commit, so flapping never reaches
 * the nodes.
 *
 * The first observation is treated as initialisation, not a transition: the
 * tracker adopts the observed metered-ness without firing, so a plugin
 * starting on an already-metered connection applies its policy at setup
 * (via {@link trafficPolicy}) rather than getting a synthetic flip. An
 * unknown boot state (the internet-state plugin not yet published) adopts
 * unmetered, so the first `metered` delta still goes through the grace path
 * and engages the throttle.
 *
 * @param {object} [options]
 * @param {number} [options.graceMs=METERED_GRACE_MS] - Hysteresis window.
 * @param {(metered: boolean) => void} [options.onChange] - Committed
 *   transitions; `metered` is the new state.
 * @returns {{observe:(raw:unknown)=>void, dispose:()=>void, state:string|null, metered:boolean|null}}
 */
function createMeteredTracker({ graceMs = METERED_GRACE_MS, onChange } = {}) {
  /** Current normalized raw state (diagnostics), or null before the first observe. */
  let state = null;
  /** Last committed metered-ness; null until the first observe. */
  let metered = null;
  /** Pending transition: {metered, timer}, cleared on commit or reversal. */
  let pending = null;

  const commit = (value) => {
    metered = value;
    if (typeof onChange === "function") {
      onChange(value);
    }
  };

  return {
    observe(raw) {
      const next = normalizeInternetState(raw);
      state = next;
      const nextMetered = isMeteredState(next);
      if (nextMetered === metered) {
        // Same committed metered-ness: any pending transition is stale.
        if (pending) {
          clearTimeout(pending.timer);
          pending = null;
        }
        return;
      }
      if (metered === null) {
        // First observation: initialisation, not a transition.
        metered = nextMetered;
        return;
      }
      if (pending && pending.metered === nextMetered) {
        // Already armed for this direction; keep waiting out the grace.
        return;
      }
      if (pending) {
        clearTimeout(pending.timer);
      }
      const timer = setTimeout(() => {
        pending = null;
        commit(nextMetered);
      }, graceMs);
      pending = { metered: nextMetered, timer };
    },
    get state() {
      return state;
    },
    get metered() {
      return metered;
    },
    /** Cancels a pending transition (plugin teardown); committed state stays. */
    dispose() {
      if (pending) {
        clearTimeout(pending.timer);
        pending = null;
      }
    },
  };
}

module.exports = {
  deps,
  INTERNET_STATE_PATH,
  METERED_STATE,
  KNOWN_HASH_RE,
  METERED_GRACE_MS,
  normalizeInternetState,
  isMeteredState,
  normalizeHashList,
  effectiveKnownHashes,
  trafficPolicy,
  makeThrottledIngestFilter,
  applyMeteredPolicy,
  createMeteredTracker,
};
