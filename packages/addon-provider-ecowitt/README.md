# Ecowitt Provider

Ecowitt weather-station device-provider addon for CamStack — wraps the @apocaliss92/nodewitt local-poll / push client.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-ecowitt` on npm.

## What it provides

- **Ecowitt** (`provider-ecowitt`): Adopt Ecowitt weather-station gateways and their sensors over the local network (poll or push). Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Gateway: Name
- Transport: Transport
- Local poll settings: Gateway host / IP, HTTP port, Password (optional), Poll interval (ms)
- Push listener settings: Listen port, Bind host (optional)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
