# Tailscale

Tailscale bundle for CamStack — joins the host to a tailnet (client) and exposes the hub via Serve/Funnel (ingress). Multi-entry npm package shipping 2 addons under a single bundle. Tailnet client + Serve/Funnel ingress.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-tailscale` on npm.

## What it provides

- **Tailscale** (`tailscale-client`): Category: networking.
  - Capabilities: `mesh-network`, `network-access`.
- **Tailscale Funnel** (`tailscale-ingress`): Exposes the CamStack hub on the tailnet (Serve) or the public internet (Funnel). Requires the Tailscale addon to be installed and joined first. Category: networking.
  - Capabilities: `network-access`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Identity: Prerequisites, Tailscale daemon, Device Hostname
- Subnet routing: Accept routes from peers, Advertise subnet routes, Advertise ACL tags
- DNS & exit node: Accept tailnet DNS, Exit node (peer id)
- Access: Shields up, Enable Tailscale SSH
- Headless / Auth key: Pre-auth key
- Tailscale Funnel: Mode, Source port, Target path (optional), Upstream scheme

## Requirements

- Placement: hub-only (runner group `net-access`).
- A CamStack hub. An agent is used only where the placement above allows it.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
