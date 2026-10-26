# @camstack/addon-provider-vesync

VeSync cloud-account device-provider addon for CamStack — Levoit / Cosori air purifiers as Fan devices (power, speed, preset, child-lock, display, air-quality + filter-life sensors)

## What it does

- **VeSync** (`provider-vesync`): Sign in to a VeSync cloud account and adopt its air purifiers as Fan devices (speed, preset, child-lock, display + air-quality / filter-life sensors)
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

