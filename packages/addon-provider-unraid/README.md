# Unraid Provider

Unraid device-provider addon for CamStack — the server as a Gateway and an instance Container with array, disk and notification entities; each Docker container and VM adopted as its own device.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-unraid` on npm.

## What it provides

- **Unraid** (`provider-unraid`): Add an Unraid server as an integration over its local GraphQL API and adopt it as a Gateway, with its array, disks and notifications as one instance Container, and each Docker container and VM as its own device. Category: providers.
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
