# Signal K integration with Reticulum Network System

This plugin connects the [Signal K](https://signalk.org/) marine platform with the [Reticulum](https://reticulum.network/) mesh networking stack, giving the boat a presence on the Reticulum mesh and enabling long-range, off-grid messaging with the crew.

[Columba](https://columba.network/), [reticulum-mobile-app](https://github.com/thatSFGuy/reticulum-mobile-app), and [Sideband](https://github.com/markqvist/sideband) are examples of Reticulum applications you can use to interact with this plugin.

## Features

- **Reticulum connectivity** — brings up a Reticulum node with the configured interfaces (TCP, AutoInterface peering, …), defaulting to zero-config `AutoInterface` peering when none are configured.
- **Shared instance support** — by default, reuse a locally running `rnsd` and its mesh interfaces; falls back to opening the configured interfaces when no shared instance is reachable.
- **Persistent identity** — generates and stores a Reticulum identity on first start, or reuses one you provide.
- **LXMF messaging** — registers the standard `lxmf.delivery` destination and announces the node to the mesh.
- **Crew alerts** — when Signal K raises a notification at the `alarm` or `emergency` level, an LXMF message is sent to each configured crew member, followed by a clear-up message once the condition clears.
- **Incoming commands** — the node receives LXMF messages and answers text commands from any peer: `ping` (replies `Pong`), and optionally `turn <switch> on` / `turn <switch> off`.
- **Embedded mesh services** — by default, the plugin runs an embedded LXMF propagation node and an embedded RFed federation node (see [Embedded nodes](#embedded-nodes)), providing store-and-forward messaging and channel telemetry services to the mesh without any external daemons.
- **Store-and-forward delivery** — when enabled, outbound alerts and command replies to a crew member who can't be reached directly are stored at a propagation node for later delivery instead of being dropped. Telemetry broadcasts are always sent directly.
- **NomadNet site** (opt-in) — serves a NomadNet site showing the basic vessel state.
- **Telemetry exchange** (opt-in) — broadcast the boat's own telemetry to the crew, and populate Signal K from crew-device telemetry.
- **RFed ship-to-ship telemetry** (opt-in) — exchange AIS-like vessel telemetry with other boats over an RFed channel, so these vessels show up as targets on charts.
- **Connectivity-change re-announce** — when a connectivity indicator changes (Starlink dropping, an LTE modem switching cells, …) the node immediately re-announces its destinations so clients rediscover the boat over a working, non-internet mesh path without waiting for the next interval.
- **Status reporting** — publishes mesh status (identity hash, display name, interfaces and traffic counters, embedded node state) under the `communication.reticulum.*` Signal K paths.

## Configuration

### Identity

On first start a new Reticulum identity is generated and stored in the plugin configuration. To reuse an existing Reticulum identity instead, paste its private key (128 bytes / 256 hex characters) into the **Identity** group.

### Shared Reticulum instance

By default the plugin connects to a locally running shared Reticulum instance (a Python `rnsd` or another daemon) over its loopback socket and reuses its mesh interfaces, rather than opening its own. The endpoint is auto-discovered from the Reticulum configuration. When no shared instance is reachable, the plugin falls back to opening the interfaces configured below.

Untick **Use shared Reticulum instance** to always open your own interfaces.

### Interfaces

Any number of Reticulum interfaces of any available type may be configured. When none are configured (and no shared instance is used), an `AutoInterface` (zero-config LAN/Wi-Fi peering) is started by default.

The [rns.recipes directory](https://directory.rns.recipes/) provides a list of public Reticulum interfaces you can connect to.

### Crew members

Each crew member is identified by the **Reticulum identity hash** of their device (32 hexadecimal characters) — the same hash NomadNet/Sideband shows for the peer. Add one entry per crew member under **Crew members**. These are the recipients of alert messages, and can interact with the vessel over LXMF messaging. The per-protocol destination hash (e.g. `lxmf.delivery`) is derived from the identity automatically, so the same entry can later be reached over other identity-based protocols without reconfiguration.

### Messaging

- **Send Signal K alerts to the crew via LXMF** — when enabled (default), `alarm`/`emergency` notifications are forwarded to the crew.
- **Allow crew to toggle digital switches by LXMF message** — when enabled (off by default), a crew member can text `turn <switch> on` / `turn <switch> off` to set `electrical.switches.<switch>.state`.
- **LXMF display name** — the name announced to the mesh for this node's `lxmf.delivery` destination, shown on crew members' messaging devices. Defaults to the vessel name with callsign (e.g. `S/Y Bergie DE OH8XYZ`) when left empty.

### Embedded nodes

By default, the plugin runs an embedded **LXMF propagation node** and an embedded **RFed federation node** in-process, sharing the plugin's Reticulum identity and persisting their state to disk:

- The propagation node stores messages for mesh clients and delivers them when the client syncs, and syncs with other propagation nodes (statically configured peers, or auto-peered ones). Messages addressed to the boat itself are delivered the moment they arrive — whether submitted directly by a remote client or pulled in via peer sync.
- The RFed federation node relays channel messages between boats and provides store-and-forward for telemetry channels.

Both serve the mesh like their standalone counterparts. Disable either under **Embedded nodes** and run your own instead if you prefer (e.g. the Python `lxmd -p` daemon, NomadNet, Sideband, or the Rust `rfed` reference).

### Store-and-forward

The plugin's own outbound messages (crew alerts, command replies) can use store-and-forward: when a crew member can't be reached directly — no known mesh path, or delivery fails — the message is submitted to a propagation node and held until they next sync. A reachable crew member always receives messages directly.

Enable **LXMF store-and-forward (propagation node)** to turn this on. With an embedded propagation node running (the default), it is used automatically. Otherwise, enter an external propagation node's `lxmf.propagation` destination hash (32 hexadecimal characters) — NomadNet, Sideband, or the Python `lxmd` daemon can run one — or leave it empty to auto-discover the closest propagation node from its announce. In external mode, the node also periodically pulls messages the propagation node is holding for it (**Sync interval**, default every 5 minutes), so messages sent to the boat while it was offline are delivered on the next sync and dispatched through the same command handler as direct ones; the propagation node's identity is persisted the moment it announces, so a restart can sync from it immediately.

Telemetry broadcasts always use direct delivery.

### Re-announces

To keep cached mesh paths fresh, the node periodically re-announces every destination it brings up — `lxmf.delivery`, `nomadnetwork.node` (NomadNet site), `rfed.delivery` (RFed client), and the embedded nodes' destinations. Without this, transit relays evict the path within minutes and peers can no longer reach you after a TTL lapses.

The **Re-announce interval (minutes)** setting controls the cadence and defaults to 30 minutes, matching Reticulum's own default. The first announce fires immediately on start, then repeats on the interval. Set it to 0 to disable periodic re-announcing and fall back to a single announce at start.

A re-established interface connection (the shared-instance link to rnsd coming back after a daemon restart or host reboot, a client interface re-dialing) also triggers an immediate re-announce of every destination, debounced to 30 seconds across interfaces so a flapping connection cannot flood the mesh. Otherwise the transport instance on the other end — which forgets a client's announced destinations when the connection drops — would silently drop everything peers send us until it hears a fresh announce.

### Connectivity-change trigger

When a connectivity indicator changes, the node re-announces its destinations immediately, so clients switch over to a still-working mesh path without waiting for the next interval. The boat's *internet* connectivity (Starlink, an LTE modem, …) may come and go, but the Reticulum mesh paths (radio, serial, LAN peering) are unaffected — a fresh announce lets clients discover and use them right away.

The **Connectivity-change trigger paths** list holds the Signal K paths to watch for value changes. It defaults to the unified internet state path (`network.internet.state`, supplied by the `signalk-internet` plugin, which covers Starlink, LTE and other uplinks); add any others you have (e.g. the Starlink provider status, or the LTE operator-name path `networking.lte.registerNetworkDisplay`, which changes on a roam). Subscribing to a path the server never publishes is harmless, so the default is safe to leave on even without `signalk-internet` installed — on such a boat, add the specific provider paths instead. Only real value transitions fire a re-announce; clear the list to disable.

### Telemetry

Under **Telemetry** the node can exchange telemetry with the crew's handheld devices (Sideband, NomadNet, MeshChat):

- **Broadcast own telemetry to the crew** — the node's position/SOG/COG, house battery state of charge and depth/tide/wind/anchor readings are sent to each crew member as a Sideband-compatible snapshot on the configured interval, so crew see the boat in their peer telemetry view. The boat's icon and colors (configured under **Appearance**) are sent along.
- **Populate Signal K from crew telemetry** — a snapshot a crew member's device sends back is decoded into Signal K under a per-crew vessel context (`vessels.urn:reticulum:identity:<hash>`), so a crew member or a dinghy tracker shows up as a vessel target on charts and instrument panels, much like an AIS target.

### RFed ship-to-ship telemetry

Under **RFed ship-to-ship telemetry** the node can exchange vessel telemetry *with other boats* over an RFed (Reticulum Federation) channel — many-to-many messaging relayed by a federation node. This is distinct from the one-to-one crew messaging above: every publishing boat on the channel hears every other. With the embedded federation node running (the default), it is used automatically; otherwise, enter an external federation node's `rfed.*` destination hash, or leave it empty to auto-discover the closest federation node from its announce (other boats' `rfed.delivery` announces are ignored). Then pick a channel (the default `public.signalk.vessels` lets boats discover each other out of the box; the RFed spec recommends public channels be `public.`-prefixed). Transmit and receive are independent opt-ins.

The snapshot carries roughly what AIS broadcasts plus basic weather — static vessel info (name, MMSI, callsign, AIS ship type, draft, length, beam, destination), dynamic navigation (position, SOG, COG, true heading, navigation state) and weather (true wind, barometric pressure, outside temperature, humidity) — in Signal K canonical units. Received boats are populated as vessel targets under `vessels.urn:mrn:imo:mmsi:<MMSI>` (Signal K's standard AIS vessel URN, so a boat heard over the mesh merges with its real AIS target), falling back to `vessels.urn:reticulum:identity:<hash>` when a publisher has no MMSI.

Safety guarantees:

- Received RFed telemetry can **only** ever update *other* vessels — never `vessels.self`. The node's own echo is dropped, a *different* publisher claiming our own MMSI is dropped and **logged at error level with the offender's identity** (so a spoof/collision is visible), and unsigned/forged messages are dropped outright.
- Each received update is **timestamped with the message's own send time**, so a stale snapshot that spent hours crossing the mesh through store-and-forward never overrides a fresher reading (e.g. real AIS).

## How alerting works

The plugin subscribes to `notifications.*` on `vessels.self`. When a notification transitions into the `alarm` or `emergency` state, an LXMF message is delivered to each crew member (addressed to the `lxmf.delivery` destination hash derived from their configured Reticulum identity hash). When the condition clears, a follow-up message reports how long it lasted (and how many transitions a flapping sensor made).

A flapping alert (e.g. a bilge sensor switching rapidly on and off) is only forwarded once per active episode, and its clear-up message only once. Once the notification clears, it is held for a debounce period before a new occurrence of the same alert will be forwarded again.

Delivery is **opportunistic** by default: each message is sent as a single encrypted Reticulum packet addressed to the recipient's `lxmf.delivery` destination. This requires the recipient's identity to be known to the node (learned from the recipient announcing). When store-and-forward is enabled, an alert to a crew member who can't be reached — or whose delivery fails — is submitted to the propagation node instead (held until the recipient next syncs); a reachable crew member still receives the alert directly. See [Store-and-forward](#store-and-forward).

## Incoming messages

The node listens for incoming LXMF messages on its `lxmf.delivery` destination and dispatches them to text commands. Commands are matched against the message content (first match wins); a command may be restricted to messages coming from configured crew members.

Available commands:

| Command | Crew only | Description |
| --- | --- | --- |
| `ping` | no | Replies `Pong`, so any peer can check the node is reachable. |
| `turn <switch> on` / `turn <switch> off` | yes | Toggles a Signal K digital switch (`electrical.switches.<switch>.state`; dotted names address nested switches, e.g. Cerbo GX relays) and replies to confirm. Requires the **Allow crew to toggle digital switches** setting to be enabled. |

Replies are sent back to the sender's `lxmf.delivery` destination (the message source hash), riding the arrival link when one exists, and falling back to store-and-forward like alerts when it is enabled.

## Status

Early development.

The plugin publishes mesh status under the `communication.reticulum.*` paths (identity hash, display name, per-interface traffic and online state, embedded node status), so the node's health can be monitored from Signal K dashboards.

## Setup recommendations

- Have an RNode on the boat, preferably connected to the machine running Signal K, and set its interface mode to `roaming` in the Reticulum config (e.g. of your shared `rnsd` instance), so peers treat the node as mobile and mesh paths via it expire faster.
- If your boat has an Internet uplink, also configure internet-based Reticulum connections (see the [directory](https://directory.rns.recipes/)), set to `boundary` mode in the Reticulum config.
- Have a mobile RNode for each crew member.

The embedded LXMF propagation node and RFed federation node provide store-and-forward and channel services on the boat by default, so no separate daemons are needed. This way Reticulum communications with the boat work both over the internet (when available) and LoRa (when reachable), with store-and-forward as needed.
