# @camstack/addon-provider-gree

Gree air-conditioner device-provider addon for CamStack — wraps the @apocaliss92/nodegree local-UDP client (LAN discovery + AES control), exposing climate-control and fan-control

## What it does

- **Gree** (`provider-gree`): Adopt Gree (and compatible) air conditioners over local UDP — climate-control + fan-control, no cloud
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

