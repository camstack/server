# Matter Broker

Matter broker addon for Dominevo — owns a Matter fabric (commissioning + the long-lived controller) via the matter.js controller and brokers commissioned Matter nodes into Dominevo.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@dominevo/addon-matter-broker` on npm.

## What it provides

- **Matter** (`matter-broker`): Own a Matter fabric and broker commissioned Matter nodes into Dominevo (commission via QR / pairing code; map endpoints to typed device caps). Category: providers.
  - Capabilities: `device-provider`, `broker`, `integration-instances`, `device-adoption`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Matter fabric: Thread operational dataset (hex, optional), Wi-Fi SSID (optional), Wi-Fi password (optional), Node reconcile interval (ms)

## Requirements

- Placement: hub-only.
- A Dominevo hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-matter-broker.md](https://github.com/dominevo/server/blob/main/docs/addons/addon-matter-broker.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
