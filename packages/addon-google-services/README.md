# @camstack/addon-google-services

Google Services — Google brokers (OAuth2): Calendar as calendar-source, Gmail send as smtp-provider.

## What it does

- **Google Services** (`google-services`): Google brokers (OAuth2 accounts): Calendar as calendar-source, Gmail send as smtp-provider.
  - Node placement: `hub-only`.
  - Capabilities: `broker`, `calendar-source`, `smtp-provider`, `addon-routes`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

