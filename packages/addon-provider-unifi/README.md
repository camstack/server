# @camstack/addon-provider-unifi

UniFi Network controller device-provider addon for CamStack — local-controller infra switches/APs (as containers) + network-client presence. No cameras.

## What it does

- **UniFi Network** (`provider-unifi`): Adopt a UniFi Network controller over the local network: infra devices (switches / APs / gateways) as containers exposing per-port PoE, restart, LED and CPU/temp/clients sensors, plus network clients as presence. Cameras are not in scope.
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

