# Matter Broker

Matter broker addon for CamStack — owns a Matter fabric (commissioning + the long-lived controller) via the matter.js controller and brokers commissioned Matter nodes into CamStack.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-matter-broker` on npm.

## What it provides

- **Matter** (`matter-broker`): Own a Matter fabric and broker commissioned Matter nodes into CamStack (commission via QR / pairing code; map endpoints to typed device caps). Category: providers.
  - Capabilities: `device-provider`, `broker`, `device-adoption`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Matter fabric: Fabrics are managed separately

**Connection**

- Matter fabric: Thread operational dataset (hex, optional), Wi-Fi SSID (optional), Wi-Fi password (optional), Node reconcile interval (ms)

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-matter-broker.md](https://github.com/camstack/server/blob/main/docs/addons/addon-matter-broker.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
