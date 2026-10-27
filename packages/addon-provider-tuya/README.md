# Tuya Provider

Tuya / Smart Life device-provider addon for CamStack — account-onboarded (Tuya IoT cloud fetch of device localKeys) + LOCAL DP control via the @apocaliss92/nodetuya encrypted-LAN client, exposing switch / water-heater-family kettle entities.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-tuya` on npm.

## What it provides

- **Tuya** (`provider-tuya`): Adopt Tuya / Smart Life devices — account-onboarded (Tuya IoT cloud fetches each device's localKey) then controlled LOCALLY over the encrypted LAN protocol (switches + kettle). Category: providers.
  - Capabilities: `device-provider`, `device-adoption`, `connection-test`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Tuya IoT cloud project: Access ID / Client ID, Access Secret / Client Secret
- Region: Data-centre region, LAN discovery window (ms)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
