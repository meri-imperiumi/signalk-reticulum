# Signal K integration with Reticulum Network System

This plugin connects the [Signal K](https://signalk.org/) marine platform with the [Reticulum](https://reticulum.network/) mesh networking stack, giving the boat a presence on the Reticulum mesh and enabling long-range, off-grid messaging with the crew.

[Columba](https://columba.network/), [reticulum-mobile-app](https://github.com/thatSFguy/reticulum-mobile-app), and [Sideband](https://github.com/markqvist/sideband) are examples of Reticulum applications you can use to interact with this plugin.

## Features

- **Reticulum connectivity** — brings up a Reticulum node with the configured interfaces (TCP, AutoInterface peering, …), defaulting to zero-config `AutoInterface` peering when none are configured.
- **Shared instance support** — by default, reuse a locally running `rnsd` and its mesh interfaces; falls back to opening the configured interfaces when no shared instance is reachable.
- **Persistent identity** — generates and stores a Reticulum identity on first start, or reuses one you provide.
- **LXMF messaging** — registers the standard `lxmf.delivery` destination and announces the node to the mesh.
- **Crew alerts** — when Signal K raises a notification at the `alarm` or `emergency` level, an LXMF message is sent to each configured crew member.
- **Incoming commands** — the node receives LXMF messages and answers text commands from any peer, starting with `ping` (replies `pong`).
- **NomadNet site** — the plugin serves a NomadNet site showing the basic vessel state
- **Connectivity-change re-announce** — when a connectivity indicator changes (Starlink dropping, an LTE modem switching cells, …) the node immediately re-announces its destinations so clients rediscover the boat over a working, non-internet mesh path without waiting for the next interval.

## Configuration

### Identity

On first start a new Reticulum identity is generated and stored in the plugin configuration. To reuse an existing Reticulum identity instead, paste its private key (128 bytes / 256 hex characters) into the **Identity** group.

### Shared Reticulum instance

By default the plugin connects to a locally running shared Reticulum instance (a Python `rnsd` or another daemon) over its loopback socket and reuses its mesh interfaces, rather than opening its own. The endpoint is auto-discovered from the Reticulum config (`~/.reticulum/config`). When no shared instance is reachable, the plugin transparently falls back to opening the interfaces configured below.

Untick **Use shared Reticulum instance** to always open your own interfaces.

### Interfaces

Any number of Reticulum interfaces of any available type may be configured. When none are configured (and no shared instance is used), an `AutoInterface` (zero-config LAN/Wi-Fi peering) is started by default.

[rns.recipes directory](https://directory.rns.recipes/) provides a list of public Reticulum interfaces you can connect to.

### Crew members

Each crew member is identified by the `lxmf.delivery` destination hash of their Reticulum device (32 hexadecimal characters). Add one entry per crew member under **Crew members**. These are the recipients of alert messages, and can interact with the vessel over LXMF messaging.

### Messaging

- **Send Signal K alerts to the crew via LXMF** — when enabled (default), `alarm`/`emergency` notifications are forwarded to the crew.
- **Allow crew to toggle digital switches by LXMF message** — when enabled (off by default), a crew member can text `turn <switch> on` / `turn <switch> off` to set `electrical.switches.<switch>.state`.
- **LXMF display name** — the name announced to the mesh for this node's `lxmf.delivery` destination, shown on crew members' messaging devices.

### Re-announces

To keep cached mesh paths fresh, the node periodically re-announces its destinations (`lxmf.delivery` and `nomadnetwork.node`, whichever are brought up). Without this, transit relays evict the path within minutes and peers can no longer reach you after a TTL lapses (PROTOCOL-SPEC.md §7.5 / §9.7).

The **Re-announce interval (minutes)** setting (under **Re-announces**) controls the cadence and defaults to 30 minutes, matching Reticulum's own default. The first announce fires immediately on start, then repeats on the interval. Set it to 0 to disable periodic re-announcing and fall back to a single announce at start.

### Connectivity-change trigger

Beyond the periodic cadence, the node re-announces its destinations the moment a connectivity indicator changes, so clients switch over to a still-working mesh path without waiting for the next interval. The boat's *internet* connectivity (Starlink, an LTE modem, …) may come and go, but the Reticulum mesh paths (radio, serial, LAN peering) are unaffected — a fresh announce lets clients discover and use them right away.

The **Connectivity-change trigger paths** list (under **Re-announces**) holds the Signal K paths to watch for value changes. It defaults to the Starlink provider status path (`network.providers.starlink.status`, supplied by the `signalk-starlink` plugin) and supports multiple providers — add your LTE modem's status path and any others. Only real value transitions fire a re-announce (a provider re-publishing the same `online` state is ignored); clear the list to disable.

## How alerting works

The plugin subscribes to `notifications.*` on `vessels.self`. When a notification transitions into the `alarm` or `emergency` state, an LXMF message is delivered to each crew member's destination hash.

A flapping alert (e.g. a bilge sensor switching rapidly on and off) is only forwarded once per active episode. Once the notification clears, it is held for a debounce period before a new occurrence of the same alert will be forwarded again.

Delivery is **opportunistic** by default: each message is sent as a single encrypted Reticulum packet addressed to the recipient's `lxmf.delivery` destination. This requires the recipient's identity to be known to the node (learned from the recipient announcing). Store-and-forward delivery via a propagation node is planned.

## Incoming messages

The node listens for incoming LXMF messages on its `lxmf.delivery` destination and dispatches them to text commands. Commands are matched against the message content (first match wins); a command may be restricted to messages coming from configured crew members.

Available commands:

| Command | Crew only | Description |
| --- | --- | --- |
| `ping` | no | Replies `pong`, so any peer can check the node is reachable. |
| `turn <switch> on` / `turn <switch> off` | yes | Toggles a Signal K digital switch (`electrical.switches.<switch>.state`) and replies to confirm. Requires the **Allow crew to toggle digital switches** setting to be enabled. |

Replies are sent back to the sender's `lxmf.delivery` destination (the message source hash).

## Status

Early development.

## Setup recommendations

- Have an RNode on the boat, preferably connected to the Signal K machine and configured to `roaming` mode (to let other clients know this RNode access point moves)
- If your boat has an Internet uplink, configure also some internet-based Reticulum connections (see [directory](https://directory.rns.recipes/)). Set these to `bondary` mode
- Have a mobile RNode for each crew member
- It is also a great idea to run an LXMF propagation node on the boat

This way Reticulum communications with the boat should work fine both over the internet (when available) and LoRa (when reachable). LXMF propagation nodes are used for store-and-forward as needed.
