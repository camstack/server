# @camstack/addon-mqtt-broker

MQTT broker registry addon for CamStack — manages external broker entries + an optional embedded aedes broker. Consumers spin up their own `mqtt.js` clients via the `mqtt-broker` cap.

## What it does

- **MQTT Broker** (`mqtt-broker`): Registry of MQTT brokers (external + optionally an embedded aedes broker). Exposes connection details via the `mqtt-broker` cap — consumer addons connect with their own `mqtt.js` clients.
  - Node placement: `hub-only`.
  - Capabilities: `mqtt-broker`, `broker`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- Runtime dependencies the node resolves: `aedes`.
- A CamStack hub. An agent is used only when the placement above allows it.

