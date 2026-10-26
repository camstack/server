# @camstack/addon-terminal

Interactive terminal sessions (pty + xterm) as a CamStack addon

## What it does

- **Terminal** (`terminal`): Interactive terminal sessions on any cluster node. Operators explicitly create virtual-camera instances from administrator-configured profile templates.
  - Node placement: `any-node`.
  - Capabilities: `terminal-session`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `zod`.
- A CamStack hub. An agent is used only when the placement above allows it.

