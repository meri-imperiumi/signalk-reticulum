/**
 * Turns off RNS 1.6.1 proof-of-work stamp *emission* for this test process.
 *
 * `@reticulum` 0.10.x flipped `TransportCore.STAMP_DESTINATIONS`,
 * `STAMP_PATH_REQUESTS` and `STAMP_LINK_REQUESTS` on by default (RNS 1.6.1
 * parity, matching upstream's "Enabled stamp generation"). Announce stamps
 * mine inside the awaited `announce()` at `DESTINATION_VALUE` 25.0 — since
 * 0.10.1 the fast node:crypto stamper mines them in its worker thread, but
 * the call still awaits ~20-80 s of wall time per destination (and the
 * WebCrypto default engine blocks far longer) — so any suite that announces
 * real identities stalls. Tests only need the pre-1.6 wire shape.
 *
 * Only the three emission knobs are touched: stamp *enforcement* stays off
 * by default, so unstamped announces, path requests and link requests are
 * accepted everywhere, both by JS peers and by the Python reference (whose
 * rollout phase also defaults enforcement off).
 *
 * `tests/python-interop.test.js` opts back in (with a reduced announce
 * mining target) to exercise the stamped wire path against the real Python
 * reference. Require and call this before any transport is constructed.
 */

const { TransportCore } = require("@reticulum/core/src/transport/transport.js");

function disableReticulumStamps() {
  TransportCore.STAMP_DESTINATIONS = false;
  TransportCore.STAMP_PATH_REQUESTS = false;
  TransportCore.STAMP_LINK_REQUESTS = false;
}

module.exports = { disableReticulumStamps, TransportCore };
