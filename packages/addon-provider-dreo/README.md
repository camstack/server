# Dreo Provider

Dreo smart-device (fan / air-circulator / purifier / heater / humidifier) device-provider addon for CamStack — wraps the @apocaliss92/nodedreo Dreo cloud client (REST + WebSocket).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-dreo` on npm.

## What it provides

- **Dreo** (`provider-dreo`): Adopt Dreo fans, air circulators, purifiers, heaters and humidifiers via the Dreo cloud. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`, `connection-test`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Dreo account: Email, Password
- Region: Region

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
