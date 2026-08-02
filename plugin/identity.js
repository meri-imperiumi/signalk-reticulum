/**
 * Resolves the Reticulum identity for the plugin from its configuration.
 *
 * On first start (no private key configured) a fresh identity is generated and
 * flagged for persistence. When a private key is configured it is loaded as-is,
 * letting the operator reuse an existing Reticulum identity. The module is
 * intentionally free of Signal K coupling so it can be unit-tested in isolation.
 *
 * @file identity.js
 */

const crypto = require("crypto");
const { Identity, toHex, fromHex } = require("@reticulum/core");

/** Raw private key export length, in bytes (x25519 priv/pub + ed25519 priv/pub). */
const PRIVATE_KEY_BYTES = 128;
/** Raw public key length, in bytes (x25519 pub + ed25519 pub). */
const PUBLIC_KEY_BYTES = 64;
/** Truncated identity/destination hash length, in bytes (SHA-256[:16]). */
const HASH_BYTES = 16;
/** Matches hexadecimal strings (after whitespace/dashes have been stripped). */
const HEX_RE = /^[0-9a-f]+$/i;

/**
 * @typedef {Object} IdentityConfig
 * @property {string} [publicKey] - Hex-encoded public key (64 bytes).
 * @property {string} [privateKey] - Hex-encoded private key (128 bytes).
 */

/**
 * @typedef {Object} ResolvedIdentity
 * @property {Identity} identity - The resolved Reticulum identity.
 * @property {string} publicKeyHex - Canonical hex public key.
 * @property {string} privateKeyHex - Canonical hex private key.
 * @property {boolean} changed - Whether configuration should be persisted
 *   (newly generated, or a derived/canonicalised value differs from what is stored).
 */

/**
 * Normalises a hex string for comparison: trims, lower-cases and strips the
 * whitespace and dashes `fromHex` tolerates. Returns an empty string for
 * non-string / empty input.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHex(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/[\s-]/g, "");
}

/**
 * Validates and decodes a hex key string of an exact byte length.
 *
 * @param {string} value - The hex string to parse.
 * @param {number} expectedBytes - The required length in bytes.
 * @param {string} label - Human-readable field name used in error messages.
 * @returns {Uint8Array}
 * @throws {Error} If the value is empty, not hexadecimal, or the wrong length.
 */
function parseHexKey(value, expectedBytes, label) {
  const clean = normalizeHex(value);
  if (!clean) {
    throw new Error(`No ${label} provided`);
  }
  if (!HEX_RE.test(clean)) {
    throw new Error(`${label} is not valid hexadecimal`);
  }
  if (clean.length !== expectedBytes * 2) {
    throw new Error(
      `${label} must be ${expectedBytes * 2} hex characters ` +
        `(${expectedBytes} bytes), got ${clean.length}`,
    );
  }
  return fromHex(clean);
}

/**
 * Resolves the Reticulum identity from the configured keys.
 *
 * - When a private key is configured it is decoded and loaded verbatim; this is
 *   how an operator overrides the identity with their own.
 * - When no private key is configured a new identity is generated and `changed`
 *   is set so the caller persists the freshly created keys for next time.
 *
 * @param {IdentityConfig|undefined} identityConfig
 * @returns {Promise<ResolvedIdentity>}
 */
async function resolveIdentity(identityConfig) {
  const cfg = identityConfig || {};
  const privateKeyInput = normalizeHex(cfg.privateKey);

  if (privateKeyInput) {
    const privBytes = parseHexKey(
      cfg.privateKey,
      PRIVATE_KEY_BYTES,
      "Private key",
    );
    const identity = await Identity.fromBytes(privBytes);
    if (!identity) {
      throw new Error("Could not load identity from the provided private key");
    }
    const publicKeyHex = toHex(await identity.getPublicKey());
    const privateKeyHex = toHex(await identity.getPrivateKey());
    return {
      identity,
      publicKeyHex,
      privateKeyHex,
      changed:
        publicKeyHex !== normalizeHex(cfg.publicKey) ||
        privateKeyHex !== privateKeyInput,
    };
  }

  const identity = await Identity.generate();
  return {
    identity,
    publicKeyHex: toHex(await identity.getPublicKey()),
    privateKeyHex: toHex(await identity.getPrivateKey()),
    changed: true,
  };
}

/**
 * Synchronous SHA-256 of a byte buffer, using Node's crypto. This is
 * byte-identical to the {@link Destination} hash derivation in
 * `@reticulum/core` (which uses the async Web Crypto `crypto.subtle`), but
 * synchronous so the crew resolver stays synchronous — every caller already
 * treats `effectiveCrew` as a plain function.
 *
 * @param {Uint8Array|Buffer} data
 * @returns {Buffer}
 */
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

/**
 * Decodes a 16-byte identity/destination hash given as a hex string (after
 * {@link normalizeHex}) into raw bytes.
 *
 * @param {string} identityHashHex
 * @returns {Uint8Array}
 * @throws {Error} If the value is not 32 hex characters.
 */
function decodeHashHex(identityHashHex) {
  const clean = normalizeHex(identityHashHex);
  if (!HEX_RE.test(clean) || clean.length !== HASH_BYTES * 2) {
    throw new Error(
      `Identity hash must be ${HASH_BYTES * 2} hex characters ` +
        `(${HASH_BYTES} bytes), got ${clean.length || "(empty)"}`,
    );
  }
  return fromHex(clean);
}

/**
 * The full app name (with aspect) of the LXMF delivery destination.
 */
const LXMF_DELIVERY_APP_NAME = "lxmf.delivery";
/**
 * The full app name (with aspect) of the NomadNetwork node destination.
 */
const NOMADNETWORK_NODE_APP_NAME = "nomadnetwork.node";

/**
 * Derives a 16-byte Reticulum destination hash for a SINGLE/GROUP destination
 * from an identity hash and the destination's full app name
 * (`appName.aspect`, e.g. {@link LXMF_DELIVERY_APP_NAME} or
 * {@link NOMADNETWORK_NODE_APP_NAME}).
 *
 * This mirrors `Destination._computeHashes()` exactly:
 *
 * ```
 * nameHash = SHA256(full_app_name)[:10]
 * destHash = SHA256(nameHash || identityHash)[:16]
 * ```
 *
 * The public key is **not** needed — a destination hash is a pure function of
 * the identity hash and the app/aspect name — so crew members can be
 * configured by their stable, protocol-agnostic Reticulum identity hash, and
 * the per-protocol destination hash (LXMF delivery, NomadNet node, …) derived
 * on demand for whatever protocol is being spoken to them.
 *
 * @param {string|Uint8Array} identityHash - 16-byte identity hash, as a hex
 *   string or raw bytes.
 * @param {string} appName - Full app name with aspect (e.g. "lxmf.delivery").
 * @returns {string} 32-character lowercase hex destination hash.
 * @throws {Error} If `identityHash` is a hex string of the wrong length.
 */
function deriveDestinationHash(identityHash, appName) {
  const identityHashBytes =
    typeof identityHash === "string"
      ? decodeHashHex(identityHash)
      : identityHash;
  const nameHash = sha256(Buffer.from(appName, "utf8")).slice(0, 10);
  const combined = Buffer.concat([nameHash, identityHashBytes]);
  return toHex(new Uint8Array(sha256(combined).slice(0, HASH_BYTES)));
}

/**
 * Derives the `lxmf.delivery` destination hash for an identity — the address
 * LXMF messages (and the per-crew telemetry/alert delivery) are sent to.
 *
 * @param {string|Uint8Array} identityHash - 16-byte identity hash.
 * @returns {string} 32-character lowercase hex destination hash.
 */
function deriveLxmfDestinationHash(identityHash) {
  return deriveDestinationHash(identityHash, LXMF_DELIVERY_APP_NAME);
}

/**
 * Derives the `nomadnetwork.node` destination hash for an identity — the
 * address identified NomadNet page requests originate from.
 *
 * @param {string|Uint8Array} identityHash - 16-byte identity hash.
 * @returns {string} 32-character lowercase hex destination hash.
 */
function deriveNomadNetworkDestinationHash(identityHash) {
  return deriveDestinationHash(identityHash, NOMADNETWORK_NODE_APP_NAME);
}

module.exports = {
  PRIVATE_KEY_BYTES,
  PUBLIC_KEY_BYTES,
  HASH_BYTES,
  LXMF_DELIVERY_APP_NAME,
  NOMADNETWORK_NODE_APP_NAME,
  resolveIdentity,
  normalizeHex,
  parseHexKey,
  deriveDestinationHash,
  deriveLxmfDestinationHash,
  deriveNomadNetworkDestinationHash,
};
