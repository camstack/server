# VeSync Provider

VeSync cloud-account device-provider addon for CamStack — Levoit / Cosori air purifiers as Fan devices (power, speed, preset, child-lock, display, air-quality + filter-life sensors).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-vesync` on npm.

## What it provides

- **VeSync** (`provider-vesync`): Sign in to a VeSync cloud account and adopt its air purifiers as Fan devices (speed, preset, child-lock, display + air-quality / filter-life sensors). Category: providers.
  - Capabilities: `device-provider`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Account: Name
- Credentials: Email, Password, Region, Poll interval (ms)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
