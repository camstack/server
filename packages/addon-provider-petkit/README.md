# PetKit Provider

PetKit smart-feeder device-provider addon for CamStack — wraps the @apocaliss92/nodepetkit PetKit cloud client.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-petkit` on npm.

## What it provides

- **PetKit** (`provider-petkit`): Adopt PetKit smart feeders via the PetKit cloud account. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`, `pet-feeder`, `connection-test`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- PetKit account: Email, Password
- Region: Region
- Advanced: Timezone (IANA), Poll cadence (ms, 0 = eager only)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
