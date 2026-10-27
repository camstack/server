# Home Assistant

Home Assistant device provider addon for CamStack. Device provider (import) + native entity export (push). Two addons, one bundle, separate processes.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-homeassistant` on npm.

## What it provides

- **Home Assistant Provider** (`provider-homeassistant`): Adopt Home Assistant devices into CamStack via WebSocket. Category: messaging.
  - Capabilities: `broker`, `device-adoption`, `vacuum-control`, `lawn-mower-control`, `running-state`, `valve`, `humidifier`, `water-heater`, `weather`, `image`, `update`, `notification-output`, `addon-routes`, `calendar-source`.
- **Home Assistant Export** (`homeassistant-export`): Pushes CamStack entities to the CamStack Home Assistant custom component over HTTP. Chooses which devices reach which Home Assistant instance; Home Assistant never polls the hub for a value. Category: exports.
  - Capabilities: `device-export`, `addon-routes`, `oauth-integration`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Calendars to import: Calendars
- Home Assistant broker: Brokers are managed separately
- Home Assistant connection: Auth mode, HA base URL, Long-lived access token, Supervisor token
- Home Assistant instances: No brokers
- Connection: Hub URL Home Assistant can reach
- Advanced: Reconcile interval (s)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-provider-homeassistant.md](https://github.com/camstack/server/blob/main/docs/addons/addon-provider-homeassistant.md)
- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)
- [packages/addon-provider-homeassistant/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-provider-homeassistant/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
