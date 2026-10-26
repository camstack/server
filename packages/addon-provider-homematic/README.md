# @camstack/addon-provider-homematic

Homematic / HomematicIP (CCU3 / RaspberryMatic) device-provider addon for CamStack — wraps the nodehomematic library

## What it does

- **Homematic** (`provider-homematic`): Connect to a Homematic CCU3 / RaspberryMatic hub and adopt its switches, covers, lights, locks, thermostats and sensors
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `broker`, `device-adoption`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `zod`.
- A CamStack hub. An agent is used only when the placement above allows it.

