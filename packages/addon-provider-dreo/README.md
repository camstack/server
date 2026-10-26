# @camstack/addon-provider-dreo

Dreo smart-device (fan / air-circulator / purifier / heater / humidifier) device-provider addon for CamStack — wraps the @apocaliss92/nodedreo Dreo cloud client (REST + WebSocket)

## What it does

- **Dreo** (`provider-dreo`): Adopt Dreo fans, air circulators, purifiers, heaters and humidifiers via the Dreo cloud
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`, `connection-test`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

