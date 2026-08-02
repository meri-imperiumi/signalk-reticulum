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
          required: ["name", "identity"],
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
              "of the propagation node to use as a store-and-forward client.",
            default: "",
            pattern: "^[0-9a-fA-F]{32}$",
            minLength: 32,
            maxLength: 32,
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
        title: "Telemetry broadcast",
        description:
          "Periodically broadcast a Sideband-compatible telemetry snapshot " +
          "(position, speed and heading, house battery state of charge, plus " +
          "depth, tide, wind, anchor watch and navigation state as custom " +
          "sensors) to every configured crew member over LXMF. The snapshot is " +
          "carried in the LXMF FIELD_TELEMETRY field, so Sideband, NomadNet and " +
          "MeshChat render it in the peer telemetry view. The same Signal K " +
          "keys the NomadNet index page serves are used, so both views stay " +
          "consistent. Off by default.",
        properties: {
          enabled: {
            type: "boolean",
            title: "Broadcast telemetry to the crew",
            description:
              "When enabled, a telemetry snapshot is sent to each configured " +
              "crew member shortly after start and then on the interval below. " +
              "Requires messaging to come up and at least one crew member to be " +
              "configured.",
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
    },
  };
}

module.exports = {
  EXCLUDED_INTERFACE_IDS,
  configKeyFor,
  buildInterfaceArray,
  buildInterfaceArrays,
  buildPluginSchema,
};
