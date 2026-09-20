# Signal K integration with Reticulum Network System

This plugin connects [Signal K](https://signalk.org/) with the [Reticulum](https://reticulum.network/) mesh networking stack, giving the boat a presence on the Reticulum mesh and enabling long-range, off-grid messaging with the crew.

[Columba](https://columba.network/), [reticulum-mobile-app](https://github.com/thatSFGuy/reticulum-mobile-app), and [Sideband](https://github.com/markqvist/sideband) are examples of Reticulum applications you can use to interact with this plugin.

## Features

- **Reticulum connectivity** — configurable interfaces of any type, defaulting to zero-config `AutoInterface` peering when none are configured.
- **Shared instance support** — reuses a locally running `rnsd` and its mesh interfaces when available, falling back to opening your own interfaces.
- **Persistent identity** — generates and stores a Reticulum identity on first start, or reuses one you provide.
- **LXMF messaging** — announces the standard `lxmf.delivery` destination to the mesh.
- **Crew alerts** — `alarm`/`emergency` notifications are sent to each configured crew member via LXMF, followed by a clear-up message once the condition clears.
- **Incoming commands** — answers text commands from any peer: `ping` (replies `Pong`), and optionally `turn <switch> on` / `turn <switch> off`.
- **Embedded mesh services** — by default, runs an embedded LXMF propagation node and an embedded RFed federation node (see [Embedded nodes](#embedded-nodes)), providing store-and-forward messaging and channel telemetry without external daemons.
- **Store-and-forward delivery** — messages to a crew member who can't be reached directly are stored at a propagation node for later delivery instead of being dropped.
- **NomadNet site** (opt-in) — serves a NomadNet site showing the basic vessel state.
- **Telemetry exchange** (opt-in) — broadcast the boat's telemetry to the crew, and populate Signal K from crew-device telemetry.
- **RFed ship-to-ship telemetry** (opt-in) — exchange AIS-like vessel telemetry with other boats over an RFed channel, so vessels show up as targets on charts.
- **Connectivity-change re-announce** — re-announces destinations immediately when connectivity changes, so clients rediscover the boat over a working mesh path without waiting for the next interval.
- **Status reporting** — publishes mesh status (identity hash, display name, interfaces and traffic counters, embedded node state) under the `communication.reticulum.*` paths.

## Configuration

### Identity

On first start a new Reticulum identity is generated and stored in the plugin configuration. To reuse an existing identity instead, paste its private key (256 hex characters) into the **Identity** group.

### Shared Reticulum instance

By default the plugin connects to a locally running shared Reticulum instance (e.g. a Python `rnsd`) over its loopback socket and reuses its mesh interfaces, falling back to opening the interfaces configured below when no shared instance is reachable. Untick **Use shared Reticulum instance** to always open your own interfaces.

### Interfaces

Any number of Reticulum interfaces of any available type may be configured. When none are configured, an `AutoInterface` (zero-config LAN/Wi-Fi peering) is started by default. The [rns.recipes directory](https://directory.rns.recipes/) lists public Reticulum interfaces you can connect to.

### Crew members

Each crew member is identified by the **Reticulum identity hash** of their device (32 hexadecimal characters) — the same hash NomadNet/Sideband shows for the peer. Crew members receive alert messages and can interact with the vessel over LXMF. Other destination hashes (e.g. `lxmf.delivery`) are derived from the identity automatically.

### Messaging

- **Send Signal K alerts to the crew via LXMF** — when enabled (default), `alarm`/`emergency` notifications are forwarded to the crew.
- **Allow crew to toggle digital switches by LXMF message** — when enabled (off by default), a crew member can text `turn <switch> on` / `turn <switch> off` to set `electrical.switches.<switch>.state`.
- **LXMF display name** — the name announced to the mesh for the `lxmf.delivery` destination. Defaults to the vessel name with callsign when left empty.

### Embedded nodes

By default the plugin runs an embedded **LXMF propagation node** and an embedded **RFed federation node** in-process, sharing the plugin's Reticulum identity and persisting state to disk. The propagation node stores messages for mesh clients until they sync; messages addressed to the boat itself are delivered on arrival. The federation node relays channel messages between boats and provides store-and-forward for telemetry channels.

Disable either and run your own instead if you prefer (e.g. the Python `lxmd -p` daemon, NomadNet, Sideband, or the Rust `rfed` reference).

### Store-and-forward

When enabled, outbound messages (crew alerts, command replies) to a crew member who can't be reached directly are submitted to a propagation node and held until their next sync. A reachable crew member always receives messages directly. Telemetry broadcasts always use direct delivery.

With an embedded propagation node running (the default), it is used automatically. Otherwise, enter an external propagation node's `lxmf.propagation` destination hash (32 hex characters), or leave it empty to auto-discover the closest one from its announce. In external mode, the node also pulls messages held for it every **Sync interval** (default 5 minutes), so messages sent while the boat was offline are delivered on the next sync.

### Re-announces

The node periodically re-announces every destination it brings up, keeping cached mesh paths fresh — without this, transit relays evict paths within minutes and peers can no longer reach you. The **Re-announce interval (minutes)** setting controls the cadence and defaults to 30 minutes, matching Reticulum's own default; set it to 0 to disable periodic re-announcing. The first announce fires immediately on start.

A re-established interface connection (e.g. the shared-instance link to `rnsd` coming back after a restart) also triggers an immediate re-announce, debounced to 30 seconds so a flapping connection cannot flood the mesh.

### Connectivity-change trigger

Internet state changes from `network.internet.state` (supplied by the `signalk-internet` plugin) are used to trigger an immediate re-announce, so clients can discover working mesh paths more quickly when an uplink comes or goes.

The **Connectivity-change trigger paths** list holds the Signal K paths to watch; add any other connectivity indicators your boat publishes. Subscribing to a path the server never publishes is harmless. Clear the list to disable.

### Telemetry

Under **Telemetry** the node can exchange telemetry with the crew's handheld devices (Sideband, NomadNet, MeshChat):

- **Broadcast own telemetry to the crew** — the node's position/SOG/COG, house battery state of charge and depth/tide/wind/anchor readings are sent to each crew member as a Sideband-compatible snapshot on the configured interval. The boat's icon and colors (configured under **Appearance**) are sent along.
- **Populate Signal K from crew telemetry** — snapshots from crew devices are decoded into Signal K under a per-crew vessel context (`vessels.urn:reticulum:identity:<hash>`), so a crew member or dinghy tracker shows up as a vessel target on charts, much like an AIS target.

### RFed ship-to-ship telemetry

The node can exchange vessel telemetry *with other boats* over an RFed (Reticulum Federation) channel — every publishing boat on the channel hears every other. With the embedded federation node running (the default), it is used automatically; otherwise enter an external federation node's `rfed.*` destination hash, or leave it empty to auto-discover the closest one. The default channel `public.signalk.vessels` lets boats discover each other out of the box. Transmit and receive are independent opt-ins.

The snapshot carries roughly what AIS broadcasts plus basic weather — vessel info (name, MMSI, callsign, AIS ship type, dimensions, draft, destination), navigation (position, SOG, COG, heading, navigation state) and weather (wind, pressure, temperature, humidity) — in Signal K canonical units. Received boats are populated under `vessels.urn:mrn:imo:mmsi:<MMSI>` (merging with their real AIS target), falling back to `vessels.urn:reticulum:identity:<hash>` when a publisher has no MMSI.

Safety guarantees:

- Received telemetry can **only** update *other* vessels, never `vessels.self`. A spoofed claim of our own MMSI is dropped and logged at error level with the offender's identity; unsigned messages are dropped outright.
- Each update is **timestamped with the message's send time**, so a stale snapshot that spent hours in store-and-forward never overrides a fresher reading.

## How alerting works

The plugin subscribes to `notifications.*` on `vessels.self`. When a notification transitions into `alarm` or `emergency`, an LXMF message is delivered to each crew member; when the condition clears, a follow-up message reports how long it lasted. A flapping alert is only forwarded once per active episode, and once cleared it is held for a debounce period before a new occurrence is forwarded again.

Delivery is **opportunistic** by default: each message is sent as a single encrypted packet addressed to the recipient's `lxmf.delivery` destination. With store-and-forward enabled, an alert to an unreachable crew member is submitted to the propagation node instead (see [Store-and-forward](#store-and-forward)).

## Incoming messages

The node listens for incoming LXMF messages and dispatches them to text commands, matched against the message content (first match wins).

| Command | Crew only | Description |
| --- | --- | --- |
| `ping` | no | Replies `Pong`, so any peer can check the node is reachable. |
| `turn <switch> on` / `turn <switch> off` | yes | Toggles a Signal K digital switch (`electrical.switches.<switch>.state`; dotted names address nested switches, e.g. Cerbo GX relays) and replies to confirm. Requires the **Allow crew to toggle digital switches** setting. |

Replies are sent back to the sender's `lxmf.delivery` destination, riding the arrival link when one exists, and falling back to store-and-forward when it is enabled.

## Status

Early development.

The plugin publishes mesh status under the `communication.reticulum.*` paths (identity hash, display name, per-interface traffic and online state, embedded node status), so the node's health can be monitored from Signal K dashboards.

## Setup recommendations

- Have an RNode on the boat, preferably connected to the machine running Signal K, and set its interface mode to `roaming` in the Reticulum config, so peers treat the node as mobile and mesh paths via it expire faster.
- If your boat has an Internet uplink, also configure internet-based Reticulum connections (see the [directory](https://directory.rns.recipes/)), set to `boundary` mode in the Reticulum config.
- Have a mobile RNode for each crew member.

The embedded propagation and federation nodes provide store-and-forward and channel services on the boat by default, so no separate daemons are needed. This way communications with the boat work both over the internet (when available) and LoRa (when reachable), with store-and-forward as needed.
