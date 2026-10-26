# @camstack/addon-provider-unraid

Unraid device-provider addon for CamStack — one Container per Unraid instance fanning out array, disk, docker and notification entities

## What it does

- **Unraid** (`provider-unraid`): Adopt an Unraid server over its local GraphQL API and expose its array, disks, docker containers and notifications as one instance Container
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

