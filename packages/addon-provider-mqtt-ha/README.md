# MQTT HA Discovery Import

Home Assistant MQTT discovery import provider for CamStack — adopts entities published on homeassistant/+/+/config.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-mqtt-ha` on npm.

## What it provides

- **MQTT HA Discovery Import** (`provider-mqtt-ha`): Import devices from Home Assistant MQTT discovery (homeassistant/+/+/config) via a configured MQTT broker. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- MQTT broker: Broker link

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)
- [packages/addon-provider-mqtt-ha/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-provider-mqtt-ha/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
