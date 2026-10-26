# @camstack/addon-provider-velux

Velux KLF-200 device-provider addon for CamStack — local-gateway window + shutter covers (positional, no tilt)

## What it does

- **Velux** (`provider-velux`): Adopt a Velux KLF-200 gateway over the local network and its windows / roller shutters (positional cover)
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

