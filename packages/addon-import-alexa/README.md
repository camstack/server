# @camstack/addon-import-alexa

Alexa device-import provider for CamStack — imports the smart-home devices in a user's Alexa account via the unofficial alexa-remote2 cookie/token client (the inverse of the Alexa exporter)

## What it does

- **Alexa Import** (`import-alexa`): Import smart-home devices from an Amazon Alexa account (unofficial cookie/token client; poll-based state sync). Maps Alexa capability interfaces onto typed CamStack device caps.
  - Node placement: `any-node`.
  - Capabilities: `device-provider`, `broker`, `device-adoption`, `addon-routes`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

