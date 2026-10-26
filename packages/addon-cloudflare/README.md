# @camstack/addon-cloudflare

Cloudflare bundle — Tunnel (network-access) + TURN relay (turn-provider). Multi-entry npm package shipping 2 addons under a single bundle.

## What it does

- **Cloudflare Tunnel** (`cloudflare-tunnel`).
  - Node placement: `hub-only`, runner group `net-access`.
  - Capabilities: `network-access`.
- **Cloudflare TURN Relay** (`cloudflare-turn`).
  - Node placement: `hub-only`, runner group `net-access`.
  - Capabilities: `turn-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

