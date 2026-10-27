# Rademacher Provider

Rademacher HomePilot device-provider addon for CamStack — wraps the @apocaliss92/noderademacher local-hub client (roller shutters over the cover cap).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-rademacher` on npm.

## What it provides

- **Rademacher** (`provider-rademacher`): Adopt a Rademacher HomePilot / Start2Smart hub over the local network and its roller shutters (positional cover). Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Hub: Name
- Connection: Hub host / IP, Password (optional), Poll interval (ms), API base path (optional)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
