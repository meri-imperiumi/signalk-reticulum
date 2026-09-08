/**
 * Runtime recovery for a busy or degraded host.
 *
 * The plugin runs inside a busy Signal K server process, often on the same
 * box as the rnsd it talks to. Under load, several failure modes wedge
 * outbound traffic in ways that never self-heal in-process:
 *
 * - **Backpressure hang**: if the shared-instance socket's reader (the rnsd)
 *   falls behind, `await iface._packetWriter.write(packet)` never settles —
 *   every awaited send piles up, and the transport's fire-and-forget
 *   broadcast writes queue silently behind it. Announces stop leaving the
 *   node while inbound traffic keeps trickling in.
 * - **Timer starvation**: a busy event loop delays the periodic re-announce
 *   and telemetry ticks; a stalled one stops them entirely for stretches.
 *
 * None of these are visible from the mesh — the node looks online. This
 * module makes them observable and recoverable:
 *
 * - {@link startLagMonitor} samples event-loop lag (timer drift), published
 *   so operators can correlate degradation with host load.
 * - {@link withTimeout} bounds any awaited send so the plugin's loops can
 *   never wedge permanently on a hung stream write.
 * - {@link watchOutboundFreeze} watches each interface's transmit byte
 *   counter. When an online interface transmits nothing for a window that
 *   must have contained outbound attempts, it first fires a re-announce
 *   probe (recovers timer/announce-loop stalls without disruption), and if
 *   the counter still does not move, **swaps the interface** — tear the
 *   wedged one down and build a fresh connection through a caller-supplied
 *   factory, the in-process equivalent of the "restart the server" fix.
 *
 * @file recovery.js
 */

/**
 * Wraps an async operation with a timeout, so a hung stream write (socket
 * backpressure, dead pipe) can never wedge a caller's loop permanently.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} timeoutMs
 * @param {string} [what] Description for the timeout error.
 * @returns {Promise<T>}
 */
async function withTimeout(fn, timeoutMs, what = "operation") {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Samples event-loop lag: the drift between scheduled and actual timer
 * callbacks. A busy (or stalled) Signal K server shows up here as large
 * spikes, giving context for interpreting interface freezes.
 *
 * @param {object} [options]
 * @param {number} [options.pollMs=10000] Sampling interval.
 * @param {(lagMs:number)=>void} [options.onSample] Called with each lag
 *   sample (never negative; a callback that fired on time reports 0).
 * @returns {() => void} stop
 */
function startLagMonitor({ pollMs = 10_000, onSample = () => {} } = {}) {
  let expected = Date.now() + pollMs;
  const timer = setInterval(() => {
    const lag = Math.max(0, Date.now() - expected);
    expected = Date.now() + pollMs;
    onSample(lag);
  }, pollMs);
  timer?.unref?.();
  return () => clearInterval(timer);
}

/**
 * The best available "actually transmitted" counter for an interface.
 *
 * `iface.txb` counts packets as they enter the outbound framer *pipeline*,
 * so a wedged pipe (socket backpressure, dead downstream) can still bump it
 * briefly while nothing reaches the wire. When the interface exposes a raw
 * Node socket, its `bytesWritten` is bytes actually handed to the kernel —
 * immune to that artifact — so it is preferred.
 *
 * @param {object} iface
 * @returns {number}
 */
function transmittedBytes(iface) {
  const socketBytes = iface?.socket?.bytesWritten;
  if (typeof socketBytes === "number") return socketBytes;
  return Number(iface?.txb) || 0;
}

/**
 * @typedef {Object} MonitoredInterface
 * @property {object} iface - The live interface instance (needs `online`
 *   and a traffic counter — `txb`, or a raw `socket` whose `bytesWritten`
 *   is preferred, see {@link transmittedBytes}).
 * @property {string} label - Human-readable name for logs.
 * @property {(oldIface:object)=>Promise<object|null>} buildReplacement - Tears
 *   the old interface down and constructs, connects and attaches a fresh one
 *   to the Reticulum node (the caller wires this to its normal setup path);
 *   resolves with the new interface, or null when it could not be rebuilt
 *   (e.g. the shared instance is unreachable right now).
 */

/**
 * @typedef {Object} FreezeWatchdogOptions
 * @property {MonitoredInterface[]} interfaces
 * @property {() => void|Promise<void>} probeAnnounce - Fires a re-announce of
 *   every destination (the first, non-disruptive recovery attempt, and the
 *   outbound traffic that proves the transmit path alive).
 * @property {(label:string, oldIface:object, newIface:object|null)=>void} [onSwapped]
 * @property {number} [stallAfterMs=1800000] Online interface with zero
 *   transmitted bytes for this long enters the probe phase. Must comfortably
 *   exceed the longest gap between legitimate outbound attempts.
 * @property {number} [probeGraceMs=120000] Wait this long after the probe
 *   announce before deciding the interface is frozen.
 * @property {number} [cooldownMs=900000] Minimum spacing between swaps of
 *   the same interface (flap protection).
 * @property {number} [pollMs=60000] Counter sampling interval.
 * @property {(...args:any[])=>void} [log] Debug logger.
 * @returns {{stop:() => void, stalledCount: () => number, recycleCount: () => number, snapshot: () => object}}
 */
function watchOutboundFreeze({
  interfaces = [],
  probeAnnounce,
  onSwapped = () => {},
  stallAfterMs = 30 * 60 * 1000,
  probeGraceMs = 2 * 60 * 1000,
  cooldownMs = 15 * 60 * 1000,
  pollMs = 60 * 1000,
  log = () => {},
}) {
  if (typeof probeAnnounce !== "function") {
    throw new Error("watchOutboundFreeze requires a probeAnnounce callback");
  }

  const state = new Map(); // label -> { counter, since, phase, lastSwapAt }
  for (const { iface, label } of interfaces) {
    state.set(label, {
      counter: transmittedBytes(iface),
      since: Date.now(),
      phase: "ok",
      lastSwapAt: 0,
    });
  }
  let stalled = 0;
  let recycles = 0;
  let stopped = false;

  async function swap(entry) {
    const { label, iface, buildReplacement } = entry;
    const s = state.get(label);
    log(
      `Outbound freeze on "${label}" (no bytes transmitted for ` +
        `${Math.round((Date.now() - s.since) / 60000)} min); recycling the interface`,
    );
    try {
      const fresh = await buildReplacement(iface);
      recycles += 1;
      if (fresh) {
        entry.iface = fresh;
        s.counter = transmittedBytes(fresh);
        log(`Interface "${label}" recycled successfully`);
      } else {
        // The rebuild path owns retry/backoff logging; reset the baseline so
        // the watchdog re-arms rather than hammering the swap in a loop.
        s.counter = transmittedBytes(iface);
        log(`Interface "${label}" could not be rebuilt yet; will re-check`);
      }
    } catch (e) {
      log(`Interface "${label}" swap failed: ${e.message}`);
    }
    s.since = Date.now();
    s.phase = "ok";
    s.lastSwapAt = Date.now();
    onSwapped(label, iface, entry.iface);
  }

  const tick = async () => {
    if (stopped) return;
    for (const entry of interfaces) {
      const s = state.get(entry.label);
      if (!s) continue;
      const iface = entry.iface;
      if (!iface || !iface.online) {
        // Offline interfaces reconnect on their own; nothing to recover.
        s.counter = transmittedBytes(iface);
        s.since = Date.now();
        s.phase = "ok";
        continue;
      }
      const counter = transmittedBytes(iface);
      if (counter > s.counter) {
        // Traffic is flowing again — healthy.
        s.counter = counter;
        s.since = Date.now();
        s.phase = "ok";
        continue;
      }
      const frozenFor = Date.now() - s.since;
      if (s.phase === "ok" && frozenFor >= stallAfterMs) {
        s.phase = "probing";
        stalled += 1;
        log(
          `No bytes transmitted on "${entry.label}" for ` +
            `${Math.round(frozenFor / 60000)} min while online; ` +
            "re-announcing to test the transmit path",
        );
        try {
          await probeAnnounce();
        } catch (e) {
          log(`Probe announce failed: ${e.message}`);
        }
        continue;
      }
      if (
        s.phase === "probing" &&
        frozenFor >= stallAfterMs + probeGraceMs &&
        Date.now() - s.lastSwapAt >= cooldownMs
      ) {
        await swap(entry);
      }
    }
  };
  const timer = setInterval(() => {
    tick().catch((e) => log(`Freeze watchdog error: ${e.message}`));
  }, pollMs);
  timer?.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    stalledCount: () => stalled,
    recycleCount: () => recycles,
    snapshot() {
      const out = {};
      for (const [label, s] of state) {
        out[label] = {
          frozenMs: Date.now() - s.since,
          phase: s.phase,
        };
      }
      return out;
    },
  };
}

module.exports = { withTimeout, startLagMonitor, watchOutboundFreeze };
