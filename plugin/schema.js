/**
 * Builds the Signal K plugin configuration JSON Schema for the Reticulum
 * integration from the available Reticulum interfaces.
 *
 * The schema exposes one top-level array per configurable Reticulum interface
 * type (e.g. `tcp_clients`, `auto_interfaces`), so each type's options are a
 * plain list of same-shaped objects the config UI can render and validate on
 * its own — there is no discriminated union, so adding an entry never produces
 * validation errors for the other interface types. Interface types that cannot
 * run on the server (browser-only; see {@link EXCLUDED_INTERFACE_IDS}) are
 * omitted. When no interfaces are configured at all, an AutoInterface
 * (zero-config LAN/Wi-Fi peering) is started by default.
 *
 * @file schema.js
 */

/**
 * @typedef {Object} InterfaceRegistryEntry
 * @property {string} id - Stable registry id, e.g. "tcp-client".
 * @property {string} name - Human-readable name (from the schema title).
 * @property {Record<string, any>} schema - JSON Schema for the interface options.
 */

/**
 * Interface registry ids that are not configurable from the Signal K server.
 * `webrtc` is browser-only (it needs the browser's WebRTC stack), so it is
 * hidden from the config UI and never started here.
 */
const EXCLUDED_INTERFACE_IDS = ["webrtc"];

/**
 * Derives the plugin config key for one interface type's instance array from
 * its stable registry id. Used by both the generated schema and the config
 * reader, so the two can never drift apart.
 *
 * `tcp-client` → `tcp_clients`, `tcp-server` → `tcp_servers`, `auto` →
 * `auto_interfaces`. Client/server ids pluralise their last segment; every
 * other id takes an `_interfaces` suffix.
 *
 * @param {string} id - Stable interface registry id.
 * @returns {string}
 */
function configKeyFor(id) {
  const parts = id.split("-");
  const last = parts[parts.length - 1];
  if (last === "client") {
    return parts.slice(0, -1).concat(["clients"]).join("_");
  }
  if (last === "server") {
    return parts.slice(0, -1).concat(["servers"]).join("_");
  }
  return `${id.replace(/-/g, "_")}_interfaces`;
}

/**
 * Builds the JSON Schema for one interface type's instance array: a plain
 * `array` of that type's own option objects, passing the interface's own
 * properties, required fields and `additionalProperties` stance straight
 * through. Each item is one configured instance, so any number of instances of
 * a type may be added.
 *
 * @param {InterfaceRegistryEntry} entry
 * @returns {Record<string, any>}
 */
function buildInterfaceArray(entry) {
  const schema = entry.schema || {};
  const name = entry.name || entry.id;
  const arrayTitle = name.endsWith("s") ? `${name}es` : `${name}s`;
  /** @type {Record<string, any>} */
  const items = {
    type: "object",
    title: name,
    properties: schema.properties || {},
    required: schema.required || [],
  };
  if (schema.description) {
    items.description = schema.description;
  }
  if (schema.additionalProperties !== undefined) {
    items.additionalProperties = schema.additionalProperties;
  }
  return {
    type: "array",
    title: arrayTitle,
    items,
  };
}

/**
 * Builds the per-interface-type array properties for the plugin schema,
 * skipping {@link EXCLUDED_INTERFACE_IDS}.
 *
 * @param {InterfaceRegistryEntry[]} interfaces
 * @returns {Record<string, any>}
 */
function buildInterfaceArrays(interfaces) {
  const arrays = {};
  for (const entry of interfaces) {
    if (EXCLUDED_INTERFACE_IDS.includes(entry.id)) {
      continue;
    }
    arrays[configKeyFor(entry.id)] = buildInterfaceArray(entry);
  }
  return arrays;
}

/**
 * Builds the full plugin configuration JSON Schema.
 *
 * @param {InterfaceRegistryEntry[]} interfaces - Entries from
 *   `@reticulum/node`'s `listInterfaces()`.
 * @returns {Record<string, any>} A JSON Schema (draft-07) object describing the
 *   plugin configuration.
 */
function buildPluginSchema(interfaces) {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: "Signal K Reticulum",
    properties: {
      log_level: {
        type: "string",
        title: "Reticulum log level",
        description:
          "Verbosity of the Reticulum stack's own diagnostic output " +
          "(transport, links, announces, pathing) written to the Signal K " +
          "server log. The default (Notice) keeps important operational events; " +
          "raise it for troubleshooting or lower it to reduce log noise. This " +
          "is independent of the plugin's own messages.",
        default: "notice",
        enum: [
          "critical",
          "error",
          "warning",
          "notice",
          "info",
          "verbose",
          "debug",
        ],
      },
      use_shared_instance: {
        type: "boolean",
        title: "Use shared Reticulum instance",
        description:
          "Connect to a locally running shared Reticulum instance (rnsd) and " +
          "reuse its mesh interfaces, instead of opening the interfaces " +
          "configured below. The endpoint is auto-discovered from the " +
          "Reticulum config. When no shared instance is reachable, the plugin " +
          "falls back to the configured interfaces.",
        default: true,
      },
      ...buildInterfaceArrays(interfaces),
      announce: {
        type: "object",
        title: "Re-announces",
        description:
          "Periodically re-announce the node's destinations so cached " +
          "mesh paths stay fresh. Reticulum's reference transport evicts " +
          "unused paths within minutes (PROTOCOL-SPEC.md §7.5 / §9.7), so " +
          "without periodic re-announces peers can no longer reach you after " +
          "a transit-relay TTL lapses. When enabled, both the lxmf.delivery " +
          "and the nomadnetwork.node destinations (whichever are brought up) " +
          "are re-announced on the interval below; the first announce fires " +
          "immediately on start. Set the interval to 0 to disable " +
          "re-announcing and fall back to a single announce at start.",
        properties: {
          reannounce_interval_minutes: {
            type: "number",
            title: "Re-announce interval (minutes)",
            description:
              "How often to re-announce the node's destinations. Defaults to " +
              "30 minutes, matching Reticulum's own default. A value of 0 " +
              "disables periodic re-announcing (a single announce is still " +
              "sent on start). Sub-minute values are clamped to a 60-second " +
              "minimum by Reticulum — shorter intervals trigger ingress rate " +
              "limiting and waste airtime (§9.7).",
            default: 30,
            minimum: 0,
          },
          connectivity_paths: {
            type: "array",
            title: "Connectivity-change trigger paths",
            description:
              "Signal K paths whose value changes trigger an immediate, " +
              "manual re-announce of every destination (lxmf.delivery and " +
              "nomadnetwork.node, whichever are brought up). This lets " +
              "clients rediscover the node — and switch over to a working, " +
              "non-internet mesh path — the moment the boat's internet " +
              "connectivity changes (e.g. the Starlink link dropping or an " +
              "LTE modem roaming to a new operator), instead of waiting up " +
              "to the re-announce interval. Add one entry per connectivity " +
              "provider. Defaults to the Starlink provider status path and " +
              "the LTE operator-name path; clear the list to disable.",
            default: [
              "network.providers.starlink.status",
              "networking.lte.registerNetworkDisplay",
            ],
            items: {
              type: "string",
              title: "Signal K path",
              description:
                "A vessels.self path to watch for value changes " +
                "(e.g. network.providers.starlink.status or " +
                "networking.lte.registerNetworkDisplay).",
            },
          },
        },
        additionalProperties: false,
      },
      identity: {
        type: "object",
        title: "Identity",
        description:
          "The Reticulum identity for this Signal K node. On first start a " +
          "new identity is generated and stored here. To reuse an existing " +
          "Reticulum identity instead, paste its private key.",
        properties: {
          publicKey: {
            type: "string",
            title: "Public key",
            description:
              "Public key for this identity (64 bytes, hexadecimal). " +
              "Derived from the private key and shown for sharing/verification.",
            readOnly: true,
          },
          privateKey: {
            type: "string",
            title: "Private key",
            description:
              "Private key for this identity (128 bytes, hexadecimal). " +
              "Leave empty to auto-generate a new identity on first start. " +
              "Paste your own to reuse an existing Reticulum identity.",
          },
        },
        additionalProperties: false,
      },
      messaging: {
        type: "object",
        title: "Messaging",
        description:
          "LXMF messaging options. When alert forwarding is enabled, Signal K " +
          "notifications at the alarm/emergency levels are sent to every " +
          "configured crew member as an LXMF message.",
        properties: {
          send_alerts: {
            type: "boolean",
            title: "Send Signal K alerts to the crew via LXMF",
            default: true,
          },
          digital_switching: {
            type: "boolean",
            title: "Allow crew to toggle digital switches by LXMF message",
            description:
              'When enabled, a crew member can text "turn <switch> on" or ' +
              '"turn <switch> off" to set the ' +
              "electrical.switches.<switch>.state path. Off by default.",
            default: false,
          },
          display_name: {
            type: "string",
            title: "LXMF display name",
            description:
              "Name announced to the mesh for this node's lxmf.delivery " +
              "destination, shown on crew members' messaging devices. " +
              "Defaults to the vessel name (with callsign) when left empty.",
            default: "",
          },
        },
        additionalProperties: false,
      },
      crew: {
        type: "array",
        title: "Crew members",
        description:
          "Reticulum identities to alert. Each entry is a crew member's " +
          "Reticulum identity hash (32 hexadecimal characters) — the same hash " +
          "shown by NomadNet/Sideband for the peer, and the canonical address " +
          "for any protocol that identifies by Reticulum identity (LXMF, " +
          "NomadNet page requests). The per-protocol destination hash (e.g. " +
          "lxmf.delivery) is derived from it automatically.",
        default: [],
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              title: "Name",
              description: "A label for this crew member (used in logs).",
            },
            identity: {
              type: "string",
              title: "Reticulum identity hash",
              description:
                "The 32-character hexadecimal Reticulum identity hash of " +
                "the crew member's device. This is protocol-agnostic: the " +
                "lxmf.delivery destination hash (used for alerts and " +
                "telemetry) is derived from it, and the same entry can later " +
                "be reached over other identity-based protocols without " +
                "reconfiguration. Find it in NomadNet/Sideband under the " +
                "peer's details (often labelled 'the hash').",
              pattern: "^[0-9a-fA-F]{32}$",
              minLength: 32,
              maxLength: 32,
            },
            destination: {
              type: "string",
              title: "LXMF destination hash (legacy)",
              description:
                "Legacy field: a raw lxmf.delivery destination hash. " +
                "This is deprecated — use 'identity' instead for protocol-agnostic " +
                "configuration. Entries with 'destination' but no 'identity' are " +
                "supported for backward compatibility, but they can only be " +
                "reached over LXMF, not other identity-based protocols.",
              pattern: "^[0-9a-fA-F]{32}$",
              minLength: 32,
              maxLength: 32,
            },
          },
          additionalProperties: false,
        },
      },
      propagation: {
        type: "object",
        title: "LXMF store-and-forward (propagation node)",
        description:
          "Act as a client of an LXMF propagation node for store-and-forward " +
          "messaging. The node never runs the propagation role itself — run a " +
          "dedicated propagation node (NomadNet, Sideband, rnsd) on the boat " +
          "and enter its lxmf.propagation destination hash here. When enabled, " +
          "the node periodically pulls messages the propagation node is holding " +
          "for it (so messages sent to the boat while it was offline are " +
          "delivered on the next sync), and outbound alerts to a crew member " +
          "who can't be reached directly are submitted to the node for " +
          "store-and-forward delivery instead of being dropped.",
        properties: {
          enabled: {
            type: "boolean",
            title: "Use a propagation node",
            description:
              "When enabled, the node syncs from (and submits to) the " +
              "propagation node whose hash is configured below. Off by default.",
            default: false,
          },
          node: {
            type: "string",
            title: "Propagation node destination hash",
            description:
              "The 32-character hexadecimal lxmf.propagation destination hash " +
              "of the propagation node to use as a store-and-forward client. " +
              "Leave empty to auto-discover the closest propagation node from " +
              "its announce on the mesh (the fewest-hops lxmf.propagation " +
              "announce heard shortly after start is used automatically).",
            default: "",
            pattern: "^([0-9a-fA-F]{32})?$",
          },
          sync_interval_minutes: {
            type: "number",
            title: "Sync interval (minutes)",
            description:
              "How often to pull stored messages from the propagation node. " +
              "Clamped to a 1-minute minimum. Each sync establishes a link to " +
              "the node and exchanges any new messages, so pick a cadence that " +
              "suits the mesh bandwidth. Defaults to 5 minutes.",
            default: 5,
            minimum: 1,
          },
        },
        additionalProperties: false,
      },
      nomadnet: {
        type: "object",
        title: "NomadNet site",
        description:
          "NomadNet mesh site. When enabled, the node announces a " +
          "nomadnetwork.node destination and serves a /page/index.mu page " +
          "that NomadNet clients (Sideband, NomadNet, MeshChat) can browse " +
          "to see the boat's status.",
        properties: {
          enabled: {
            type: "boolean",
            title: "Serve a NomadNet site",
            description:
              "Announce a NomadNet node destination and serve its index " +
              "page over the mesh. Off by default.",
            default: false,
          },
          display_name: {
            type: "string",
            title: "NomadNet node name",
            description:
              "Name announced to the mesh for this node's " +
              "nomadnetwork.node destination. Defaults to the vessel name " +
              "(with callsign) when left empty.",
            default: "",
          },
          banner: {
            type: "string",
            title: "Page banner",
            format: "textarea",
            description:
              "Optional ASCII/micron banner shown at the top of the index " +
              "page instead of the vessel name. Multi-line ASCII art is " +
              "rendered as-is; lines that begin with micron directives (!, >, " +
              "-, etc.) are interpreted by the client, so prefer art that " +
              "does not. Leave empty to show the vessel name as a heading.",
            default: "",
          },
          footer: {
            type: "string",
            title: "Page footer",
            format: "textarea",
            description:
              "Optional ASCII/micron text shown at the bottom of the index " +
              "page, after the telemetry. Useful for contact details, a " +
              "MMSI/callsign reminder or a static note. Multi-line content is " +
              "rendered as-is; lines that begin with micron directives (!, >, " +
              "-, etc.) are interpreted by the client. Leave empty for no " +
              "footer.",
            default: "",
          },
        },
        additionalProperties: false,
      },
      telemetry: {
        type: "object",
        title: "Telemetry",
        description:
          "Telemetry exchange with the crew. The node can broadcast its own " +
          "Sideband-compatible snapshot to the crew (outbound) and populate " +
          "Signal K from telemetry snapshots it receives back from crew " +
          "members' devices (inbound). The snapshot is carried in the LXMF " +
          "FIELD_TELEMETRY field, so Sideband, NomadNet and MeshChat render it " +
          "in the peer telemetry view, and a crew member's position/battery " +
          "appears in Signal K as a vessel target (on charts, instrument " +
          "panels) much like an AIS target.",
        properties: {
          enabled: {
            type: "boolean",
            title: "Broadcast own telemetry to the crew",
            description:
              "When enabled, the node's telemetry snapshot (position, speed " +
              "and heading, house battery state of charge, plus depth, tide, " +
              "wind, anchor watch and navigation state as custom sensors) is " +
              "sent to each configured crew member shortly after start and " +
              "then on the interval below. Requires messaging to come up and " +
              "at least one crew member to be configured.",
            default: false,
          },
          interval_seconds: {
            type: "number",
            title: "Broadcast interval (seconds)",
            description:
              "How often to re-broadcast the telemetry snapshot. Clamped to a " +
              "30-second minimum to avoid flooding the mesh. Choose with the " +
              "mesh bandwidth in mind — opportunistic LXMF delivery creates a " +
              "packet per recipient per interval.",
            default: 300,
            minimum: 30,
          },
          populate_crew_telemetry: {
            type: "boolean",
            title: "Populate Signal K from crew telemetry",
            description:
              "When enabled, a telemetry snapshot received from a configured " +
              "crew member over LXMF is decoded and written into Signal K " +
              "under a per-crew vessel context (vessels.urn:reticulum:" +
              "identity:<hash>), so the crew member shows up as a vessel " +
              "target — with position, speed/heading, device battery state of " +
              "charge and any environmental sensors — on charts (Freeboard) " +
              "and instrument panels. Mirrors how signalk-meshtastic populates " +
              "Signal K from mesh nodes. Off by default.",
            default: false,
          },
        },
        additionalProperties: false,
      },
      rfed: {
        type: "object",
        title: "RFed ship-to-ship telemetry",
        description:
          "Share and receive vessel telemetry with other Signal K boats over " +
          "an RFed (Reticulum Federation) channel — many-to-many messaging " +
          "relayed by a federation node. Each boat publishes its own AIS-like " +
          "snapshot (static vessel info, dynamic position/SOG/COG/heading and " +
          "basic weather) to a channel, and received boats are populated as " +
          "Signal K vessel targets so they show up on charts and instrument " +
          "panels like AIS targets. Transmit and receive are independent " +
          "opt-ins. RFed is a separate protocol from the Sideband/Columba crew " +
          "messaging: run an rfed federation node and enter any of its rfed.* " +
          "destination hashes below. The snapshot uses a custom versioned " +
          "format (both ends are Signal K nodes), not Sideband's packed " +
          "telemetry, and is carried in the LXMF FIELD_TELEMETRY field.",
        properties: {
          enabled: {
            type: "boolean",
            title: "Enable RFed",
            description:
              "Master switch for the RFed channel client. When off, no " +
              "destination is brought up and nothing is subscribed, published " +
              "or received. Off by default.",
            default: false,
          },
          node: {
            type: "string",
            title: "RFed node destination hash",
            description:
              "Any 32-character hexadecimal rfed.* destination hash of the " +
              "rfed federation node to subscribe to and publish through (they " +
              "all share one identity). Find it from the federation node's " +
              "announce. Leave empty to auto-discover the closest federation " +
              "node from its announce on the mesh (the fewest-hops rfed.* " +
              "announce heard shortly after start is used automatically; " +
              "other boats' rfed.delivery announces are ignored).",
            default: "",
            pattern: "^([0-9a-fA-F]{32})?$",
          },
          channel: {
            type: "string",
            title: "Channel name",
            description:
              "The rfed channel name to subscribe to and publish on. The RFed " +
              "spec recommends public channels be prefixed 'public.'; the " +
              "default public 'public.signalk.vessels' channel lets boats " +
              "discover each other out of the box. Set a custom name (e.g. a " +
              "'<hex>.fleet' private channel) to restrict the exchange to a " +
              "known group.",
            default: "public.signalk.vessels",
          },
          transmit_telemetry: {
            type: "boolean",
            title: "Transmit own telemetry to the channel",
            description:
              "When enabled, the node's vessel snapshot (static AIS-like info, " +
              "dynamic navigation and basic weather) is published to the " +
              "channel shortly after start and then on the interval below. " +
              "Requires a valid node destination hash. Off by default.",
            default: false,
          },
          receive_telemetry: {
            type: "boolean",
            title: "Populate Signal K from received vessel telemetry",
            description:
              "When enabled, a vessel snapshot received from any other " +
              "signed publisher on the channel is written into Signal K under " +
              "a per-vessel context (vessels.urn:reticulum:identity:<hash>), " +
              "so nearby boats show up as vessel targets on charts and " +
              "instrument panels. Unsigned/forged messages are dropped, and " +
              "the node's own echo is ignored, so received RFed telemetry only " +
              "ever updates other vessels — never vessels.self. The update is " +
              "timestamped with the message's own send time, so a stale " +
              "store-and-forward snapshot never overrides a fresher reading " +
              "(e.g. real AIS). Off by default.",
            default: false,
          },
          interval_seconds: {
            type: "number",
            title: "Transmit interval (seconds)",
            description:
              "How often to re-publish the vessel snapshot to the channel. " +
              "Clamped to a 30-second minimum to avoid flooding the mesh. " +
              "Choose with the mesh bandwidth in mind — each publish is " +
              "relayed to every subscriber by the federation node. Defaults " +
              "to 300 seconds.",
            default: 300,
            minimum: 30,
          },
        },
        additionalProperties: false,
      },
      appearance: {
        type: "object",
        title: "Appearance",
        description:
          "Icon and colors advertised to LXMF peers (Sideband, MeshChat) so " +
          "crew members' devices show a recognisable avatar for this node " +
          "alongside its telemetry. The icon is a Material Design Icon name " +
          "(e.g. 'sail-boat', 'ferry', 'anchor'); the colors are RGB hex " +
          "strings. The appearance is carried in the LXMF " +
          "FIELD_ICON_APPEARANCE message field and sent with each telemetry " +
          "broadcast, so telemetry broadcast must be enabled for peers to " +
          "receive it. When the icon is left empty it is derived from the " +
          "vessel's AIS ship type (design.aisShipType): a sail-boat icon for " +
          "sailing vessels, a ferry icon for everything else.",
        properties: {
          icon: {
            type: "string",
            title: "Icon",
            description:
              "Material Design Icon name shown as this node's avatar on " +
              "peers' devices. Leave empty to derive automatically from the " +
              "vessel's AIS ship type (sail-boat for sailing vessels, ferry " +
              "otherwise).",
            default: "",
          },
          fg_color: {
            type: "string",
            title: "Foreground color",
            description:
              "Icon/foreground color as an RGB hex string (e.g. '#ffffff'). " +
              "Used by peers to tint the node's avatar.",
            format: "color",
            default: "#ffffff",
          },
          bg_color: {
            type: "string",
            title: "Background color",
            description:
              "Background color behind the icon, as an RGB hex string " +
              "(e.g. '#1a237e').",
            format: "color",
            default: "#1a237e",
          },
        },
        additionalProperties: false,
      },
      embedded_nodes: {
        type: "object",
        title: "Embedded nodes",
        description:
          "Run an LXMF propagation node and/or an RFed federation node " +
          "directly inside this plugin. When enabled, the plugin provides " +
          "store-and-forward messaging and channel telemetry services to " +
          "the mesh without requiring external nodes. The embedded nodes " +
          "share the same Reticulum instance and identity with the rest of " +
          "the plugin, and their state survives restarts via disk " +
          "persistence. When an embedded node is running, the plugin uses " +
          "it instead of looking for an external node.",
        properties: {
          propagation: {
            type: "object",
            title: "LXMF propagation node",
            description:
              "Embedded LXMF propagation node configuration. When enabled, " +
              "the plugin runs an lxmf.propagation node that stores messages " +
              "for mesh clients until they sync. This replaces the need for " +
              "an external propagation node (the propagation.enabled setting " +
              "is ignored when this is enabled).",
            properties: {
              enabled: {
                type: "boolean",
                title: "Run embedded LXMF propagation node",
                description:
                  "When enabled, the plugin runs its own LXMF propagation " +
                  "node. The node stores messages for mesh clients and " +
                  "delivers them when the clients sync. On by default.",
                default: true,
              },
              name: {
                type: "string",
                title: "Propagation node name",
                description:
                  "Display name announced for this propagation node. " +
                  "Defaults to the vessel's LXMF display name.",
                default: "",
              },
              stamp_cost: {
                type: "number",
                title: "Stamp cost (bits)",
                description:
                  "Proof-of-work leading-zero bits required for messages " +
                  "submitted to this propagation node. Set to 0 to disable. " +
                  "Defaults to 8 bits.",
                default: 8,
                minimum: 0,
                maximum: 32,
              },
              peering_cost: {
                type: "number",
                title: "Peering cost (bits)",
                description:
                  "Cost advertised to other propagation nodes for peering " +
                  "requests. Higher values discourage peering. Defaults to " +
                  "18 bits.",
                default: 18,
                minimum: 0,
                maximum: 32,
              },
              autopeer: {
                type: "boolean",
                title: "Auto-peer with other propagation nodes",
                description:
                  "When enabled, automatically peer with other discovered " +
                  "propagation nodes whose peering cost is at or below the " +
                  "max cost. Off by default.",
                default: false,
              },
              autopeer_max_cost: {
                type: "number",
                title: "Auto-peer max cost (bits)",
                description:
                  "Maximum peering cost for auto-peering. Only propagation " +
                  "nodes advertising a cost at or below this value are " +
                  "auto-peered with. Ignored when auto-peer is disabled.",
                default: 18,
                minimum: 0,
                maximum: 32,
              },
              storage_limit_mb: {
                type: "number",
                title: "Storage limit (MB)",
                description:
                  "Maximum storage for stored LXMF messages. Old messages " +
                  "are evicted when the limit is reached. Leave empty for " +
                  "unlimited.",
                default: null,
                minimum: 1,
              },
              message_ttl_days: {
                type: "number",
                title: "Message TTL (days)",
                description:
                  "Maximum age for stored LXMF messages. Old messages are " +
                  "pruned regardless of storage limit. Leave empty for " +
                  "unlimited.",
                default: null,
                minimum: 1,
              },
              peers: {
                type: "array",
                title: "Static propagation peers",
                description:
                  "List of 32-character hexadecimal destination hashes of " +
                  "propagation nodes to sync with periodically. Messages " +
                  "are exchanged on sync. Leave empty for no static peers.",
                default: [],
                items: {
                  type: "string",
                  pattern: "^[0-9a-fA-F]{32}$",
                  minLength: 32,
                  maxLength: 32,
                },
              },
            },
            additionalProperties: false,
          },
          rfed: {
            type: "object",
            title: "RFed federation node",
            description:
              "Embedded RFed federation node configuration. When enabled, " +
              "the plugin runs its own rfed federation node that relays " +
              "channel messages and provides store-and-forward for " +
              "telemetry channels. This replaces the need for an external " +
              "RFed node (the rfed.node setting is ignored when this is enabled).",
            properties: {
              enabled: {
                type: "boolean",
                title: "Run embedded RFed federation node",
                description:
                  "When enabled, the plugin runs its own RFed federation " +
                  "node. The node relays channel messages and provides " +
                  "store-and-forward for telemetry channels. On by default.",
                default: true,
              },
              name: {
                type: "string",
                title: "Federation node name",
                description:
                  "Display name announced for this federation node. " +
                  "Defaults to 'rfed'.",
                default: "rfed",
              },
              stamp_cost: {
                type: "number",
                title: "Stamp cost (bits)",
                description:
                  "Proof-of-work leading-zero bits required for channel " +
                  "messages. Set to 0 to disable. Defaults to 16 bits.",
                default: 16,
                minimum: 0,
                maximum: 32,
              },
              stamp_flexibility: {
                type: "number",
                title: "Stamp flexibility (bits)",
                description:
                  "Downward cost tolerance for stamp validation. A message " +
                  "with a stamp cost at least this many bits below the " +
                  "required cost is accepted. Defaults to 3 bits.",
                default: 3,
                minimum: 0,
                maximum: 32,
              },
              storage_limit_mb: {
                type: "number",
                title: "Storage limit (MB)",
                description:
                  "Maximum storage for channel blobs. Old blobs are evicted " +
                  "when the limit is reached. Leave empty for unlimited.",
                default: null,
                minimum: 1,
              },
              blob_ttl_days: {
                type: "number",
                title: "Blob TTL (days)",
                description:
                  "Maximum age for stored blobs. Old blobs are pruned " +
                  "regardless of storage limit. Defaults to 30 days.",
                default: 30,
                minimum: 1,
              },
              deferred_ttl_days: {
                type: "number",
                title: "Deferred delivery TTL (days)",
                description:
                  "Maximum age for entries in the deferred delivery queue. " +
                  "Defaults to 7 days.",
                default: 7,
                minimum: 1,
              },
              maintenance_interval_seconds: {
                type: "number",
                title: "Maintenance interval (seconds)",
                description:
                  "How often to run maintenance (prune old messages/blobs, " +
                  "persist stores to disk). Defaults to 3600 seconds (1 " +
                  "hour).",
                default: 3600,
                minimum: 60,
              },
              backup_interval_seconds: {
                type: "number",
                title: "Backup tick interval (seconds)",
                description:
                  "How often to run backup failover checks (push deferred " +
                  "messages to backup nodes, adopt from failed owners). " +
                  "Defaults to 30 seconds.",
                default: 30,
                minimum: 10,
              },
              sync_peers: {
                type: "array",
                title: "Static federation peers",
                description:
                  "List of 32-character hexadecimal destination hashes of " +
                  "other RFed federation nodes to sync with periodically. " +
                  "These are seeded as immediately-due sync targets (sync " +
                  "fires on startup). By default the node also auto-discovers " +
                  "and syncs with every other rfed.node peer it hears on the " +
                  "mesh; enable 'from_static_only' to restrict federation to " +
                  "just these peers. Leave empty for no static peers.",
                default: [],
                items: {
                  type: "string",
                  pattern: "^[0-9a-fA-F]{32}$",
                  minLength: 32,
                  maxLength: 32,
                },
              },
              from_static_only: {
                type: "boolean",
                title: "Sync only with the static peers above",
                description:
                  "When enabled, the node only syncs with the federation " +
                  "peers listed under 'sync_peers' and ignores every other " +
                  "rfed.node peer discovered on the mesh (an explicit " +
                  "allow-list). When disabled (the default), the node syncs " +
                  "with every discovered rfed.node peer and additionally seeds " +
                  "the 'sync_peers' for immediate sync — the federation " +
                  "behaviour matching the Rust rfed CLI. Useful on a slow or " +
                  "expensive link where you only want to federate with " +
                  "trusted peers. Requires at least one 'sync_peers' entry " +
                  "to have any effect.",
                default: false,
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  };
}

/**
 * Feature groups whose options are rarely needed day-to-day. In the admin UI
 * they are ordered after the essentials so the common settings surface first.
 *
 * Note: the Signal K docs describe making a group `collapsible` via
 * `ui:field: "collapsible"` from `react-jsonschema-form-extras`. That does NOT
 * work in current Signal K server builds (verified against server 2.29.0):
 * the admin UI migrated to `@rjsf/core` v5 and bundles neither
 * `react-jsonschema-form-extras` nor any theme that registers a `collapsible`
 * field, so the entry is silently ignored. RJSF v5 has no built-in collapsible
 * field, and a plugin can only reference fields the admin UI already
 * registers — so true collapse is not achievable from a plugin's uiSchema. We
 * therefore rely on the native RJSF v5 levers that DO work — `ui:order`
 * (reorder) and `ui:widget: "hidden"` (hide) — to cut visual noise.
 */
const ADVANCED_GROUPS = [
  "announce",
  "propagation",
  "nomadnet",
  "telemetry",
  "rfed",
  "appearance",
  "embedded_nodes",
];

/**
 * Builds the plugin configuration uiSchema.
 *
 * The JSON Schema's top-level shape is left untouched (so existing saved
 * configs and every config reader keep working); the uiSchema only controls
 * how the Signal K admin UI lays the fields out, using the RJSF v5 features
 * the admin UI actually supports (see {@link ADVANCED_GROUPS} for why
 * `collapsible` is not used):
 *
 *  - `ui:order` surfaces the essentials first — the shared-instance switch,
 *    the crew-alerting setup (`messaging`, `crew`) and `identity` — then the
 *    advanced feature groups, then the mesh interface arrays, and finally the
 *    log level. The nine interface arrays are only relevant when
 *    `use_shared_instance` is off (the default is on), so they are pushed to
 *    the end instead of dominating the top of the form.
 *  - `ui:widget: "hidden"` hides the derived, read-only `identity.publicKey`
 *    (it is computed from the private key, and the node's identity hash is
 *    already published under `communication.reticulum.identityHash`), keeping
 *    the Identity group focused on the one field users actually manage.
 *
 * @param {InterfaceRegistryEntry[]} interfaces
 * @returns {Record<string, any>}
 */
function buildPluginUiSchema(interfaces) {
  const uiSchema = {
    // Essentials first: the shared-instance switch and the crew-alerting setup
    // are what almost every user configures. Identity follows (paste a
    // private key once, or leave it to auto-generate).
    "ui:order": ["use_shared_instance", "messaging", "crew", "identity"],
  };

  // Advanced feature groups, in declared order.
  for (const key of ADVANCED_GROUPS) {
    uiSchema["ui:order"].push(key);
  }

  // Mesh interface arrays — only relevant when `use_shared_instance` is off
  // (the default is on), so they go last (before the log level) instead of
  // dominating the top of the form.
  for (const entry of interfaces) {
    if (EXCLUDED_INTERFACE_IDS.includes(entry.id)) {
      continue;
    }
    uiSchema["ui:order"].push(configKeyFor(entry.id));
  }

  // Log level is a troubleshooting knob — dead last.
  uiSchema["ui:order"].push("log_level");

  // Hide the derived public key; users manage the private key only (the
  // node's identity hash is already published under
  // communication.reticulum.identityHash).
  uiSchema.identity = {
    publicKey: { "ui:widget": "hidden" },
  };

  return uiSchema;
}

module.exports = {
  EXCLUDED_INTERFACE_IDS,
  configKeyFor,
  buildInterfaceArray,
  buildInterfaceArrays,
  buildPluginSchema,
  buildPluginUiSchema,
  ADVANCED_GROUPS,
};
