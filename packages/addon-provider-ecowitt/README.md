# @camstack/addon-provider-ecowitt

Ecowitt weather-station device-provider addon for CamStack — wraps the @apocaliss92/nodewitt local-poll / push client

## What it does

- **Ecowitt** (`provider-ecowitt`): Adopt Ecowitt weather-station gateways and their sensors over the local network (poll or push)
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

