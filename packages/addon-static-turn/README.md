# Static / coturn TURN

Static / self-hosted (coturn) TURN provider for Dominevo.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@dominevo/addon-static-turn` on npm.

## What it provides

- **TURN Server** (`static-turn`): Category: networking.
  - Capabilities: `turn-provider`, `integration-instances`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- TURN / STUN server: How to fill, TURN / STUN URLs, Username, Credential / password

## Requirements

- Placement: hub-only (runner group `net-access`).
- A Dominevo hub. An agent is used only where the placement above allows it.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
