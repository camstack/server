# @camstack/addon-agent-ui

Agent UI — lightweight status dashboard served by every agent node

## What it does

- **Agent UI** (`agent-ui`): Lightweight status dashboard for agent nodes
  - Node placement: `agent-only`.
  - Capabilities: `admin-ui`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

