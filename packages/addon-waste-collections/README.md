# Waste Collection

Waste collection schedules via the vendored HACS waste_collection_schedule Python core — full source catalog as calendar-source.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-waste-collections` on npm.

## What it provides

- **Waste Collections** (`waste-collections`): Fetches municipal waste collection schedules through the HACS waste_collection_schedule source catalog (full set) and exposes them as calendars. Category: messaging.
  - Capabilities: `calendar-source`.

## Requirements

- Placement: hub-only.
- Python: Waste Collections installs `python/requirements.txt` into its own environment.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-waste-collections.md](https://github.com/camstack/server/blob/main/docs/addons/addon-waste-collections.md)
- [docs/architecture/secrets-keychain.md](https://github.com/camstack/server/blob/main/docs/architecture/secrets-keychain.md)
- [packages/addon-waste-collections/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-waste-collections/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
