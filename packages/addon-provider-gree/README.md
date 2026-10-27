# Gree Provider

Gree air-conditioner device-provider addon for CamStack — wraps the @apocaliss92/nodegree local-UDP client (LAN discovery + AES control), exposing climate-control and fan-control.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-gree` on npm.

## What it provides

- **Gree** (`provider-gree`): Adopt Gree (and compatible) air conditioners over local UDP — climate-control + fan-control, no cloud. Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Air conditioner: Name, IP address
- Advanced (UDP): Broadcast address (optional), UDP timeout (ms), Retries, Encryption

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
