# @camstack/addon-provider-homeassistant

Home Assistant device provider addon for CamStack

## What it does

- **Home Assistant** (`provider-homeassistant`): Adopt Home Assistant devices into CamStack via WebSocket
  - Node placement: `hub-only`.
  - Capabilities: `broker`, `device-adoption`, `vacuum-control`, `lawn-mower-control`, `running-state`, `valve`, `humidifier`, `water-heater`, `weather`, `image`, `update`, `notification-output`, `addon-routes`, `calendar-source`.
- **Home Assistant Export** (`homeassistant-export`): Pushes CamStack entities to the CamStack Home Assistant custom component over HTTP. Chooses which devices reach which Home Assistant instance; Home Assistant never polls the hub for a value.
  - Node placement: `hub-only`.
  - Capabilities: `device-export`, `addon-routes`, `oauth-integration`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

