# Dreame Provider

Dreame robot-vacuum / lawn-mower device-provider addon for CamStack — wraps the @apocaliss92/nodedreame Dreamehome cloud client.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-dreame` on npm.

## What it provides

- **Dreame** (`provider-dreame`): Adopt Dreame robot vacuums and lawn mowers via the Dreamehome cloud. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`, `consumables`, `navigation`, `recording-signal`, `connection-test`, `running-state`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Dreamehome account: Email / username, Password
- Region: Region
- Advanced: Poll fallback interval (ms, 0 = disabled)

**Per-device settings**

- Map Style: Colour scheme, Cleaning path, Robot, Charger, No-go / no-mop zones, Virtual walls, Obstacles, Room id labels, and 4 more

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
