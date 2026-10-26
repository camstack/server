# @camstack/addon-export-alexa

Alexa Smart Home Skill export — hub-side OAuth provider + directive handler. The companion AWS Lambda forwards Alexa directives to this addon's /addon/export-alexa/directive endpoint.

## What it does

- **Alexa Smart Home export** (`export-alexa`): Hub-side OAuth provider + Smart Home directive handler. Pairs with a user-owned AWS Lambda that forwards Alexa directives to this addon. Skeleton: AcceptGrant + Discovery implemented; CameraStream / RTC / Doorbell push in next dispatch.
  - Node placement: `hub-only`.
  - Capabilities: `device-export`, `addon-routes`, `oauth-integration`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

