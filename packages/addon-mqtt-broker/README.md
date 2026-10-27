# MQTT Broker

MQTT broker registry addon for CamStack — manages external broker entries + an optional embedded aedes broker. Consumers spin up their own `mqtt.js` clients via the `mqtt-broker` cap.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-mqtt-broker` on npm.

## What it provides

- **MQTT Broker** (`mqtt-broker`): Registry of MQTT brokers (external + optionally an embedded aedes broker). Exposes connection details via the `mqtt-broker` cap — consumer addons connect with their own `mqtt.js` clients. Category: messaging.
  - Capabilities: `mqtt-broker`, `broker`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- MQTT connection: Run an onboard broker, Port, Allow anonymous, Broker URL, Username, Password, Client ID prefix
- Embedded broker: Run embedded broker, Port, Allow anonymous, Shared username, Shared password
- Embedded broker — credentials: Clients
- Embedded broker — topic ACL: Rules

## Requirements

- Placement: hub-only.
- Runtime dependencies installed with the addon: `aedes`.
- A CamStack hub. An agent is used only where the placement above allows it.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
