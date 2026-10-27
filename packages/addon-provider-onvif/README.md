# @camstack/addon-provider-onvif

ONVIF camera device provider addon for CamStack

## What it does

- **ONVIF** (`provider-onvif`): Discovery automatica di camere ONVIF sulla rete locale
  - Node placement: `any-node`.
  - Capabilities: `device-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- Runtime dependencies the node resolves: `onvif`.
- A CamStack hub. An agent is used only when the placement above allows it.

