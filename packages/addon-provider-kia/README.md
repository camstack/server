# Kia Connect Provider

Kia Connect (Kia UVO / Hyundai Bluelink) vehicle device-provider addon for CamStack: reads the car (odometer, range, fuel, locks, doors, tyre warnings, position) and locks, unlocks and pre-conditions it through the maker cloud, in a bundled Python worker.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-kia` on npm.

## What it provides

- **Kia Connect** (`provider-kia`): Adopt a Kia (or Hyundai / Genesis) connected car: state, position, service distance, lock and climate through the maker cloud. Category: providers.
  - Capabilities: `device-provider`, `integration-instances`, `device-adoption`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Kia Connect account: Username, Password, Security PIN
- Cloud: Region, Brand

## Requirements

- Placement: hub-only.
- Python: Kia Connect installs `python/requirements.txt` into its own environment.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
