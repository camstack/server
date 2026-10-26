# @camstack/addon-provider-tuya

Tuya / Smart Life device-provider addon for CamStack — account-onboarded (Tuya IoT cloud fetch of device localKeys) + LOCAL DP control via the @apocaliss92/nodetuya encrypted-LAN client, exposing switch / water-heater-family kettle entities

## What it does

- **Tuya** (`provider-tuya`): Adopt Tuya / Smart Life devices — account-onboarded (Tuya IoT cloud fetches each device's localKey) then controlled LOCALLY over the encrypted LAN protocol (switches + kettle)
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`, `connection-test`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

