# @camstack/addon-osd-manager

Binds camera on-screen-display slots to live state and recognitions

## What it does

- **OSD Manager** (`osd-manager`): Drives the text a camera burns into its own video. Each overlay slot can be bound to device state, the latest recognized person or plate, a clock, or a literal. Writes nothing when the rendered text has not changed.
  - Node placement: `hub-only`.
  - Capabilities: `osd-manager`, `addon-pages-source`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `react`, `react-dom`, `zod`.
- A CamStack hub. An agent is used only when the placement above allows it.

