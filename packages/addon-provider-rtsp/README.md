# @camstack/addon-provider-rtsp

Generic RTSP camera device provider addon for CamStack

## What it does

- **RTSP** (`provider-rtsp`): Direct connection to cameras via RTSP URL
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `connection-test`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `zod`.
- A CamStack hub. An agent is used only when the placement above allows it.

