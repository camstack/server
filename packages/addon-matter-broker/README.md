# @camstack/addon-matter-broker

Matter broker addon for CamStack — owns a Matter fabric (commissioning + the long-lived controller) via the matter.js controller and brokers commissioned Matter nodes into CamStack

## What it does

- **Matter** (`matter-broker`): Own a Matter fabric and broker commissioned Matter nodes into CamStack (commission via QR / pairing code; map endpoints to typed device caps). Operator steps: `docs/addons/addon-matter-broker.md`.
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `broker`, `device-adoption`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

