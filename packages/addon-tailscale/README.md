# @camstack/addon-tailscale

Tailscale bundle for CamStack — joins the host to a tailnet (client) and exposes the hub via Serve/Funnel (ingress). Multi-entry npm package shipping 2 addons under a single bundle.

## What it does

- **Tailscale** (`tailscale-client`).
  - Node placement: `hub-only`, runner group `net-access`.
  - Capabilities: `mesh-network`, `network-access`.
- **Tailscale Funnel** (`tailscale-ingress`): Exposes the CamStack hub on the tailnet (Serve) or the public internet (Funnel). Requires the Tailscale Client addon to be installed and joined first.
  - Node placement: `hub-only`, runner group `net-access`.
  - Capabilities: `network-access`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

