# @camstack/addon-static-turn

Static / self-hosted (coturn) TURN provider for CamStack

## What it does

- **TURN Server** (`static-turn`).
  - Node placement: `hub-only`, runner group `net-access`.
  - Capabilities: `turn-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

