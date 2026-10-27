# @camstack/addon-waste-collections

Waste collection schedules via the vendored HACS waste_collection_schedule Python core — full source catalog as calendar-source.

## What it does

- **Waste Collection** (`waste-collections`): Fetches municipal waste collection schedules through the HACS waste_collection_schedule source catalog (full set) and exposes them as calendars.
  - Node placement: `hub-only`.
  - Capabilities: `calendar-source`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

