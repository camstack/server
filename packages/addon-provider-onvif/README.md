# ONVIF Provider

ONVIF camera device provider addon for CamStack.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-onvif` on npm.

## What it provides

- **ONVIF** (`provider-onvif`): Discovery automatica di camere ONVIF sulla rete locale. Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Default Credentials: Default Username, Default Password

## Requirements

- Placement: default placement.
- Runtime dependencies installed with the addon: `onvif`.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
