# @camstack/addon-admin-ui

Admin UI — Vite frontend build and server-side addon

## What it does

- **Admin UI** (`admin-ui`): Web-based administration interface for CamStack
  - Node placement: `any-node`.
  - Capabilities: `admin-ui`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

