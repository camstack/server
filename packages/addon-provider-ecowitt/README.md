# Ecowitt Provider

Ecowitt weather-station device-provider addon for CamStack — wraps the @apocaliss92/nodewitt local-poll / push client.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-ecowitt` on npm.

## What it provides

- **Ecowitt** (`provider-ecowitt`): Add an Ecowitt weather-station gateway as an integration (local poll or push) and adopt its Gateway device, group containers and sensors. Category: providers.
  - Capabilities: `device-provider`, `integration-instances`, `device-adoption`, `weather-station`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

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
