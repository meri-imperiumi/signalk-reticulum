/**
 * Signal K plugin integrating the server with the Reticulum Network System.
 *
 * @param {import("@signalk/server-api").ServerAPI} app
 * @returns {import("@signalk/server-api").Plugin}
 */
const { Reticulum, toHex, LXMessage, Destination } = require("@reticulum/core");
const {
  getInterface,
  listInterfaces,
  LocalClientInterface,
} = require("@reticulum/node");
const { buildPluginSchema, EXCLUDED_INTERFACE_IDS } = require("./schema");
const { resolveIdentity } = require("./identity");
const { effectiveInterfaces, setupInterfaces, interfacesFromConfig } =
  require("./interfaces");
const { sendNotification } = require("./notifications");
const { setupMessaging, makeDeliverer, makeTelemetryDeliverer } =
  require("./messaging");
const { setupNomadNet } = require("./nomadnet");
const { readNumber, readPosition, readString } = require("./nomadnet");
const compression = require("./compression");
const { resolveDisplayName } = require("./displayname");
const { resolveAppearance } = require("./appearance");
const { createStorageAdapter, setupCrewPersistence } = require("./storage");
const { effectiveCrew } = require("./notifications");
const { buildTelemetrySensors, packTelemetry } = require("./telemetry");
const commands = require("./commands");

/**
 * Overridable dependencies (the Reticulum orchestrator class, the interface
 * registry lookup, and the shared-instance connector factory). Defaults point
 * at the real @reticulum packages; tests swap these for fakes so the plugin
 * can be exercised without network I/O.
 */
const deps = {
  Reticulum,
  getInterface,
  connectSharedInstance: LocalClientInterface.connectToSharedInstance,
  createStorageAdapter,
  setupCrewPersistence,
};

/**
 * Reads a `vessels.self` path from the Signal K app, tolerating servers (and
 * test fakes) that do not expose `getSelfPath`. Returns the raw value — a plain
 * string or a `{value}` wrapper — or `undefined`; {@link resolveDisplayName}
 * normalises it from there.
 *
 * @param {{getSelfPath?: (path: string) => unknown}|undefined} app
 * @param {string} path
 * @returns {unknown}
 */
function readSelf(app, path) {
  if (!app || typeof app.getSelfPath !== "function") {
    return undefined;
  }
  try {
    return app.getSelfPath(path);
  } catch {
    return undefined;
  }
}

/**
 * Reads the boat's current telemetry from Signal K and builds a packed
 * Sideband-compatible snapshot (`Telemeter.packed()` bytes), or `null` when no
 * readings at all are available.
 *
 * Pulls the same Signal K keys the NomadNet index page serves (position, SOG,
 * COG, house battery, depth, tide, wind, anchor watch, navigation state) so the
 * telemetry broadcast and the browsed page stay consistent. Each raw value is
 * unwrapped/converted to the units the telemetry packer expects.
 *
 * @param {{getSelfPath?: (path: string) => unknown}|undefined} app
 * @returns {Uint8Array|null}
 */
function buildSnapshot(app) {
  const position = readPosition(readSelf(app, "navigation.position"));
  const speedMs = readNumber(readSelf(app, "navigation.speedOverGround"));
  const bearingRad = readNumber(
    readSelf(app, "navigation.courseOverGroundTrue"),
  );
  const altitudeM = readNumber(readSelf(app, "navigation.position.altitude"));
  const batterySoc = readNumber(
    readSelf(app, "electrical.batteries.house.capacity.stateOfCharge"),
  );
  const batteryCurrent = readNumber(
    readSelf(app, "electrical.batteries.house.current"),
  );
  const depthM = readNumber(readSelf(app, "environment.depth.belowSurface"));
  const tideHeightM = readNumber(readSelf(app, "environment.tide.heightNow"));
  const tideState = readString(readSelf(app, "environment.tide.state"));
  const windSpeedMs = readNumber(
    readSelf(app, "environment.wind.speedOverGround"),
  );
  const windDirectionRad = readNumber(
    readSelf(app, "environment.wind.directionTrue"),
  );
  const anchorDistanceM = readNumber(
    readSelf(app, "navigation.anchor.distanceFromBow"),
  );
  const vesselState = readString(readSelf(app, "navigation.state"));

  const readings = {
    now: Math.floor(Date.now() / 1000),
    latitude: position && position.latitude,
    longitude: position && position.longitude,
    altitudeM,
    speedMs,
    bearingRad,
    batteryPercent:
      batterySoc != null ? Math.round(batterySoc * 1000) / 10 : undefined,
    batteryCharging: batteryCurrent != null ? batteryCurrent > 0 : undefined,
    depthM,
    tideHeightM,
    tideState,
    windSpeedMs,
    windDirectionRad,
    anchorDistanceM,
    vesselState,
  };

  return packTelemetry(buildTelemetrySensors(readings), readings.now);
}

/**
 * Builds a telemetry snapshot from the current Signal K state and sends it to
 * every configured crew member via the LXMF telemetry deliverer. Returns the
 * number of crew members it was sent to. Per-recipient failures are logged and
 * do not abort the remaining recipients; nothing is sent when there is no
 * telemetry to send or no crew is configured.
 *
 * @param {{debug?:(...args:any[])=>void, error?:(...args:any[])=>void, getSelfPath?:(path:string)=>unknown}|undefined} app
 * @param {{crew?:unknown}|null|undefined} settings
 * @param {(destinationHashHex:string, packedTelemetry:Uint8Array)=>Promise<void>} deliverTelemetry
 * @returns {Promise<number>}
 */
async function sendTelemetryToCrew(app, settings, deliverTelemetry) {
  const debug =
    app && typeof app.debug === "function" ? (msg) => app.debug(msg) : () => {};
  const error =
    app && typeof app.error === "function" ? (msg) => app.error(msg) : () => {};
  if (!deliverTelemetry) {
    return 0;
  }
  const packed = buildSnapshot(app);
  if (!packed) {
    return 0;
  }
  const crew = effectiveCrew(settings && settings.crew, debug);
  let sent = 0;
  for (const member of crew) {
    try {
      await deliverTelemetry(member.destinationHash, packed);
      sent += 1;
    } catch (e) {
      error(`Failed to send telemetry to ${member.name}: ${e.message}`);
    }
  }
  return sent;
}

module.exports = (app) => {
  /** Tracks active notification episodes so flapping alerts aren't re-sent. */
  const episodes = new Map();
  /** Signal K subscription unsubscribe callbacks, drained on stop. */
  const unsubscribes = [];

  /**
   * Builds the options object passed to the `Reticulum` constructor from the
   * plugin config. The storage adapter is always forwarded (null when the
   * server exposes no data directory); `logLevel` is only forwarded when the
   * operator has configured one, so an unset value leaves Reticulum's own
   * default / `RETICULUM_LOG_LEVEL` env var in effect.
   *
   * @param {object|undefined} config
   * @param {unknown} storageAdapter
   * @returns {{storageAdapter: unknown, logLevel?: string}}
   */
  function rnsOptions(config, storageAdapter) {
    const opts = { storageAdapter };
    const level =
      config && typeof config.log_level === "string"
        ? config.log_level.trim()
        : "";
    if (level) {
      opts.logLevel = level;
    }
    return opts;
  }

  /** @type {import("@signalk/server-api").Plugin} */
  const plugin = {
    id: "signalk-reticulum",
    name: "Signal K Reticulum",
    description:
      "Connects Signal K to the Reticulum Network System mesh network.",
    /** Resolved Reticulum identity (available after start). */
    identity: undefined,
    /** The Reticulum node (available after start). */
    rns: undefined,
    /** Connected interface instances (available after start). */
    interfaces: [],
    /**
     * The LXMF router (available after start). Exposed so inbound LXMF message
     * handling can be added later by attaching to its `"message"` events.
     */
    lxmf: undefined,
    /**
     * The NomadNet site handle (available after start when enabled). Exposed so
     * later steps can extend the served page with live telemetry.
     */
    nomadnet: undefined,

    /**
     * Resolves (or generates) the identity, brings up the Reticulum node and
     * connects the configured interfaces.
     *
     * @param {object} config
     * @param {(newConfiguration: object) => void} restart
     */
    async start(config, restart) {
      plugin.identity = undefined;
      plugin.rns = undefined;
      plugin.interfaces = [];
      plugin.lxmf = undefined;
      plugin.nomadnet = undefined;

      let resolved;
      try {
        resolved = await resolveIdentity(config && config.identity);
      } catch (e) {
        app.setPluginError(`Identity error: ${e.message}`);
        app.debug(`Identity error: ${e.message}`);
        return;
      }
      plugin.identity = resolved.identity;
      const hashHex = toHex(resolved.identity.identityHash);

      if (resolved.changed) {
        app.savePluginOptions(
          {
            ...config,
            identity: {
              privateKey: resolved.privateKeyHex,
              publicKey: resolved.publicKeyHex,
            },
          },
          (err) => {
            if (err) {
              app.debug(`Failed to persist identity: ${err.message}`);
              return;
            }
            app.debug(`Persisted Reticulum identity ${hashHex}`);
          },
        );
      }

      try {
        const storageAdapter = deps.createStorageAdapter(
          typeof app.getDataDirPath === "function"
            ? app.getDataDirPath()
            : null,
          app.debug,
        );
        const rns = new deps.Reticulum(rnsOptions(config, storageAdapter));
        plugin.rns = rns;
        app.debug(`Loaded Reticulum identity ${hashHex}`);

        // Wire bzip2 as the Reticulum compressionProvider so compressed
        // inbound/outbound Resources work (SPEC §10.2). Best-effort: a WASM
        // init failure is logged and leaves compression disabled rather than
        // failing start.
        try {
          rns.compressionProvider = await compression.createBz2Provider(
            app.debug,
          );
        } catch (e) {
          app.debug(`bzip2 provider setup failed: ${e.message}`);
        }

        // Pre-emptively persist crew member identities the moment their
        // announces are heard, so a restart can still reach them.
        unsubscribes.push(
          deps.setupCrewPersistence(rns, config && config.crew, app.debug),
        );

        // Optionally reuse a locally running shared Reticulum instance (rnsd)
        // and its mesh interfaces. Enabled by default: when no shared instance
        // is reachable we transparently fall back to the configured interfaces.
        const useSharedInstance = !(
          config && config.use_shared_instance === false
        );
        let usedSharedInstance = false;
        if (useSharedInstance) {
          try {
            const shared = await deps.connectSharedInstance({});
            if (shared) {
              rns.addInterface(shared, true);
              plugin.interfaces = [shared];
              usedSharedInstance = true;
              app.debug("Connected to shared Reticulum instance");
            } else {
              app.debug("No shared Reticulum instance available");
            }
          } catch (e) {
            app.debug(`Failed to connect to shared instance: ${e.message}`);
          }
        }

        let setupErrors = [];
        if (!usedSharedInstance) {
          const configurableIds = listInterfaces()
            .map((entry) => entry.id)
            .filter((id) => !EXCLUDED_INTERFACE_IDS.includes(id));
          const list = effectiveInterfaces(
            interfacesFromConfig(config, configurableIds),
          );
          const defaulted = list.every(
            (entry) => entry && entry.type === "auto",
          );
          if (defaulted) {
            app.debug(
              "No interfaces configured; starting default AutoInterface",
            );
          }
          const result = await setupInterfaces(
            rns,
            list,
            deps.getInterface,
            app.debug,
          );
          plugin.interfaces = result.connected;
          setupErrors = result.errors;
        }

        // Resolve the periodic re-announce cadence so both the LXMF and
        // NomadNet destinations use the same interval. An explicit 0 disables
        // re-announcing (one-shot announce only); an absent/invalid value
        // defaults to 30 minutes (PROTOCOL-SPEC.md §9.7 / Reticulum's own
        // default), so existing configs and fresh installs both keep their
        // mesh paths fresh without operator action.
        const raw =
          config && config.announce
            ? config.announce.reannounce_interval_minutes
            : undefined;
        const configured = Number(raw);
        const reannounceMinutes = Number.isNaN(configured)
          ? 30
          : Math.max(0, configured);
        const announceIntervalMs =
          reannounceMinutes > 0 ? reannounceMinutes * 60 * 1000 : null;

        // Bring up LXMF messaging so alerts can be sent to the crew. A failure
        // here is non-fatal: the node stays up for connectivity, just without
        // messaging (deliver stays undefined and alerts are skipped).
        let deliver;
        /** Telemetry delivery callback (set when messaging comes up). */
        let deliverTelemetry;
        try {
          const displayName = resolveDisplayName({
            configured:
              config && config.messaging && config.messaging.display_name,
            vesselName: readSelf(app, "name"),
            callsign: readSelf(app, "communication.callsignVhf"),
          });
          plugin.lxmf = await setupMessaging(
            rns,
            plugin.identity,
            {
              displayName,
              announceIntervalMs,
            },
            app.debug,
          );
          // Halt the LXMF periodic re-announce loop on teardown (the router
          // has no stop() of its own; rns.stop() tears down interfaces).
          const lxmf = plugin.lxmf;
          unsubscribes.push(() => {
            try {
              lxmf.stopAnnouncing();
            } catch {
              /* best effort */
            }
          });
          deliver = makeDeliverer(plugin.lxmf, plugin.identity, app.debug);
          // Resolve the node's icon/colors once at startup (the vessel's AIS
          // ship type rarely changes) so every telemetry broadcast advertises
          // the same recognisable avatar to crew members' devices.
          const appearance = resolveAppearance({
            icon: config && config.appearance && config.appearance.icon,
            fgColor: config && config.appearance && config.appearance.fg_color,
            bgColor: config && config.appearance && config.appearance.bg_color,
            aisShipType: readSelf(app, "design.aisShipType"),
          });
          app.debug(
            `Node appearance: icon=${appearance.icon}, fg=[${appearance.fg.join(
              ",",
            )}], bg=[${appearance.bg.join(",")}]`,
          );
          deliverTelemetry = makeTelemetryDeliverer(
            plugin.lxmf,
            plugin.identity,
            appearance,
          );

          // Handle incoming LXMF messages (ping/pong, and future commands)
          // from any peer on the mesh.
          const onLxmfMessage = async (event) => {
            const message = event && event.detail && event.detail.message;
            // The arrival Link id: replies sent over this established Link are
            // prompt and reliable (the path the LXMF echobot uses), whereas an
            // opportunistic reply needs a fresh path and the recipient identity
            // known via announce. Undefined for opportunistic inbound packets.
            const linkId = event && event.detail && event.detail.link;
            if (!message) {
              return;
            }
            app.debug(
              `Received LXMF message from ${toHex(message.sourceHash || [])}`,
            );
            try {
              await commands.handleMessage(
                message,
                config,
                deliver,
                app,
                linkId,
              );
            } catch (e) {
              app.debug(`LXMF message handling error: ${e.message}`);
            }
          };
          plugin.lxmf.addEventListener("message", onLxmfMessage);
          unsubscribes.push(() => {
            try {
              plugin.lxmf.removeEventListener("message", onLxmfMessage);
            } catch {
              /* best effort */
            }
          });

          // Diagnostics on the inbound choke points so the Signal K log shows
          // exactly where a peer's message stalls — without needing RNS's own
          // DEBUG console logging. The `lxmf.delivery` destination emits a
          // `"data"` event for every opportunistic (single-packet) inbound
          // message right after it decrypts (and sends the packet PROOF). At
          // that point we parse just the source hash and report whether we can
          // already recall the sender's identity: if it is UNKNOWN the router
          // parks the message and solicits a path/announce, and the message is
          // only dispatched once that announce arrives. This makes flaky
          // first-contact / path-exchange issues visible instead of silent.
          const onInboundData = async (event) => {
            const plaintext = event && event.detail && event.detail.plaintext;
            if (!plaintext) return;
            try {
              const parsed = await LXMessage.deserialize(
                plaintext,
                plugin.lxmf.deliveryDest.destinationHash,
              );
              const known = await Destination.recall(parsed.sourceHash);
              app.debug(
                `Inbound LXMF data packet from ${toHex(
                  parsed.sourceHash || [],
                )} (${plaintext.length} bytes); sender identity ${
                  known
                    ? "known"
                    : "UNKNOWN - message parked until announce/path arrives"
                }`,
              );
            } catch (e) {
              app.debug(
                `Inbound LXMF data packet (${plaintext.length} bytes) could not be parsed: ${e.message}`,
              );
            }
          };
          plugin.lxmf.deliveryDest.addEventListener("data", onInboundData);
          unsubscribes.push(() => {
            try {
              plugin.lxmf.deliveryDest.removeEventListener(
                "data",
                onInboundData,
              );
            } catch {
              /* best effort */
            }
          });

          // A peer announce (or inbound-link LINKIDENTIFY) makes a previously
          // unknown sender's identity available, which un-parks any message
          // waiting for it. Logging it lets the operator correlate an inbound
          // message with the announce that finally released it.
          const onPeer = (event) => {
            const destinationHash =
              event && event.detail && event.detail.destinationHash;
            if (destinationHash) {
              app.debug(
                `Learned LXMF peer ${toHex(destinationHash)} (announce/identity received)`,
              );
            }
          };
          plugin.lxmf.addEventListener("peer", onPeer);
          unsubscribes.push(() => {
            try {
              plugin.lxmf.removeEventListener("peer", onPeer);
            } catch {
              /* best effort */
            }
          });
        } catch (e) {
          app.debug(`Messaging setup error: ${e.message}`);
        }

        // Optionally broadcast a Sideband-compatible telemetry snapshot
        // (position, battery, depth/tide/wind/anchor as custom sensors) to every
        // configured crew member on a fixed interval. Opt-in: nothing is sent
        // unless enabled. Skipped silently when messaging did not come up.
        if (
          deliverTelemetry &&
          config &&
          config.telemetry &&
          config.telemetry.enabled
        ) {
          const intervalMs =
            Math.max(30, Number(config.telemetry.interval_seconds) || 0) * 1000;
          const sendOnce = () =>
            sendTelemetryToCrew(app, config, deliverTelemetry).catch((e) =>
              app.debug(`Telemetry broadcast error: ${e.message}`),
            );
          // Send one snapshot shortly after start so crew see the boat
          // without waiting a full interval, then on the recurring timer.
          const initial = setTimeout(sendOnce, 5000);
          const timer = setInterval(sendOnce, intervalMs);
          unsubscribes.push(() => {
            clearTimeout(initial);
            clearInterval(timer);
          });
        }

        // Optionally bring up a NomadNet site so the boat can serve pages on
        // the mesh. Opt-in: nothing is announced or served unless enabled.
        if (config && config.nomadnet && config.nomadnet.enabled) {
          try {
            const nodeDisplayName = resolveDisplayName({
              configured: config.nomadnet && config.nomadnet.display_name,
              vesselName: readSelf(app, "name"),
              callsign: readSelf(app, "communication.callsignVhf"),
            });
            const site = await setupNomadNet(
              rns,
              plugin.identity,
              {
                displayName: nodeDisplayName,
                announceIntervalMs,
                getContext: () => ({
                  vesselName: readSelf(app, "name"),
                  banner: config.nomadnet && config.nomadnet.banner,
                  footer: config.nomadnet && config.nomadnet.footer,
                  telemetry: {
                    state: readSelf(app, "navigation.state"),
                    position: readSelf(app, "navigation.position"),
                    anchorDistance: readSelf(
                      app,
                      "navigation.anchor.distanceFromBow",
                    ),
                    depth: readSelf(app, "environment.depth.belowSurface"),
                    tideHeight: readSelf(app, "environment.tide.heightNow"),
                    tideState: readSelf(app, "environment.tide.state"),
                    windSpeed: readSelf(
                      app,
                      "environment.wind.speedOverGround",
                    ),
                    windDirection: readSelf(
                      app,
                      "environment.wind.directionTrue",
                    ),
                    batterySoc: readSelf(
                      app,
                      "electrical.batteries.house.capacity.stateOfCharge",
                    ),
                    batteryCurrent: readSelf(
                      app,
                      "electrical.batteries.house.current",
                    ),
                  },
                }),
              },
              app.debug,
            );
            plugin.nomadnet = site;
            unsubscribes.push(() => {
              try {
                site.stop();
              } catch {
                /* best effort */
              }
            });
          } catch (e) {
            app.debug(`NomadNet setup error: ${e.message}`);
          }
        }

        // Subscribe to Signal K notifications so alarm/emergency states are
        // forwarded to the crew over LXMF.
        if (app.subscriptionmanager) {
          try {
            app.subscriptionmanager.subscribe(
              {
                context: "vessels.self",
                subscribe: [{ path: "notifications.*", policy: "instant" }],
              },
              unsubscribes,
              (err) => app.error(`Notification subscription error: ${err}`),
              (delta) => {
                if (!delta || !delta.updates) {
                  return;
                }
                for (const update of delta.updates) {
                  if (!update.values) {
                    continue;
                  }
                  for (const v of update.values) {
                    if (!v.path || v.path.indexOf("notifications.") !== 0) {
                      continue;
                    }
                    Promise.resolve(
                      sendNotification(
                        v.path,
                        v.value,
                        episodes,
                        config,
                        deliver,
                        app,
                      ),
                    ).catch((e) =>
                      app.debug(`Notification forward error: ${e.message}`),
                    );
                  }
                }
              },
            );
          } catch (e) {
            app.debug(`Notification subscription error: ${e.message}`);
          }
        }

        const connectivity = usedSharedInstance
          ? "connected to shared Reticulum instance"
          : `${plugin.interfaces.length} interface(s) connected`;
        const summary = `Identity ${hashHex}, ${connectivity}`;
        if (setupErrors.length) {
          app.setPluginError(
            `${summary}; ${setupErrors.length} failed: ` +
              setupErrors.map((e) => e.error).join("; "),
          );
        } else {
          app.setPluginStatus(summary);
        }
        app.debug(summary);
      } catch (e) {
        app.setPluginError(`Start error: ${e.message}`);
        app.debug(`Start error: ${e.message}`);
      }
    },

    /**
     * Disconnects every interface, detaches them from the node and clears state.
     */
    async stop() {
      app.debug("Stopping");
      unsubscribes.splice(0).forEach((fn) => {
        try {
          fn();
        } catch {
          /* best effort */
        }
      });
      episodes.clear();
      const rns = plugin.rns;
      try {
        // Reticulum.stop() disconnects every attached interface and flushes
        // the persistence layer, so the final debounced batch isn't lost.
        if (rns && typeof rns.stop === "function") {
          await rns.stop();
        }
      } catch (e) {
        app.debug(`Teardown error: ${e.message}`);
      }
      plugin.lxmf = undefined;
      plugin.nomadnet = undefined;
      plugin.identity = undefined;
      plugin.rns = undefined;
      plugin.interfaces = [];
      app.setPluginStatus("Stopped");
    },

    schema: () => buildPluginSchema(listInterfaces()),
  };
  return plugin;
};

// Exposed for tests to override Reticulum/registry without network I/O.
module.exports.deps = deps;
// Exposed for tests so the telemetry snapshot/broadcast can be exercised
// without bringing up the full Reticulum stack.
module.exports.buildSnapshot = buildSnapshot;
module.exports.sendTelemetryToCrew = sendTelemetryToCrew;
