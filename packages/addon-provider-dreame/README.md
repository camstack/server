# @camstack/addon-provider-dreame

Dreame robot-vacuum / lawn-mower device-provider addon for CamStack — wraps the @apocaliss92/nodedreame Dreamehome cloud client

## What it does

- **Dreame** (`provider-dreame`): Adopt Dreame robot vacuums and lawn mowers via the Dreamehome cloud
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`, `consumables`, `navigation`, `recording-signal`, `connection-test`, `running-state`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

