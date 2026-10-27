# Unraid Provider

Unraid device-provider addon for CamStack — one Container per Unraid instance fanning out array, disk, docker and notification entities.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-unraid` on npm.

## What it provides

- **Unraid** (`provider-unraid`): Adopt an Unraid server over its local GraphQL API and expose its array, disks, docker containers and notifications as one instance Container. Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Unraid server: Name
- Connection: Host / IP, Port, Use HTTPS, API key, Poll interval (ms)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
