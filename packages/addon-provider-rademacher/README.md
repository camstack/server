# @camstack/addon-provider-rademacher

Rademacher HomePilot device-provider addon for CamStack — wraps the @apocaliss92/noderademacher local-hub client (roller shutters over the cover cap)

## What it does

- **Rademacher** (`provider-rademacher`): Adopt a Rademacher HomePilot / Start2Smart hub over the local network and its roller shutters (positional cover)
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

