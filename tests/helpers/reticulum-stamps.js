/**
 * Turns off RNS 1.6.1 proof-of-work stamp *emission* for this test process.
 *
 * `@reticulum` 0.10.0 flipped `TransportCore.STAMP_DESTINATIONS`,
 * `STAMP_PATH_REQUESTS` and `STAMP_LINK_REQUESTS` on by default (RNS 1.6.1
 * parity, matching upstream's "Enabled stamp generation"). Announce stamps
 * mine inline inside the awaited `announce()` at `DESTINATION_VALUE` 25.0 —
 * measured ~37 s per destination even on the fast node:crypto stamper, and
 * far longer on the WebCrypto default — so any suite that announces real
 * identities stalls. Tests only need the pre-0.10.0 wire shape.
 *
 * Only the three emission knobs are touched: stamp *enforcement* stays off
 * by default in 0.10.0, so unstamped announces, path requests and link
 * requests are accepted everywhere, both by JS peers and by the Python
 * reference (whose rollout phase also defaults enforcement off).
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
