# Cloudflare

Cloudflare bundle — Tunnel (network-access) + TURN relay (turn-provider). Multi-entry npm package shipping 2 addons under a single bundle. Tunnel (public access) + TURN relay (WebRTC).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-cloudflare` on npm.

## What it provides

- **Cloudflare Tunnel** (`cloudflare-tunnel`): Category: networking.
  - Capabilities: `network-access`.
- **Cloudflare TURN** (`cloudflare-turn`): Category: networking.
  - Capabilities: `turn-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Tunnel Mode: Mode, Local Address
- Custom Domain Setup: How to get an API token, Cloudflare API Token, Zone, Sub-domain, Local port, Port, Skip TLS verification, SNI override (optional), and 2 more
- Diagnostics: When to use, Debug logging, Transport protocol
- Cloudflare Credentials: How to get the TURN Key ID + API Token, TURN Key ID, API Token, Test credentials, Usage & free quota

## Requirements

- Placement: hub-only (runner group `net-access`).
- A CamStack hub. An agent is used only where the placement above allows it.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
