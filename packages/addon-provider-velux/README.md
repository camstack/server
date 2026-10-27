# Velux Provider

Velux KLF-200 device-provider addon for CamStack — local-gateway window + shutter covers (positional, no tilt).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-velux` on npm.

## What it provides

- **Velux** (`provider-velux`): Adopt a Velux KLF-200 gateway over the local network and its windows / roller shutters (positional cover). Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Gateway: Name
- Connection: Gateway host / IP, Password, Poll interval (ms)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
