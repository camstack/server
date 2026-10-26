# @camstack/addon-provider-mqtt-ha

Home Assistant MQTT discovery import provider for CamStack — adopts entities published on homeassistant/+/+/config

## What it does

- **MQTT HA Discovery Import** (`provider-mqtt-ha`): Import devices from Home Assistant MQTT discovery (homeassistant/+/+/config) via a configured MQTT broker
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

