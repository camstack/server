# OSD Manager

Binds camera on-screen-display slots to live state and recognitions.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-osd-manager` on npm.

## What it provides

- **OSD Manager** (`osd-manager`): Drives the text a camera burns into its own video. Each overlay slot can be bound to device state, the latest recognized person or plate, a clock, or a literal. Writes nothing when the rendered text has not changed. Category: system.
  - Capabilities: `osd-manager`, `addon-pages-source`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/osd-manager.md](https://github.com/camstack/server/blob/main/docs/architecture/osd-manager.md)
- [packages/addon-osd-manager/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-osd-manager/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
