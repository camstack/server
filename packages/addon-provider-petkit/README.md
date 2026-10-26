# @camstack/addon-provider-petkit

PetKit smart-feeder device-provider addon for CamStack — wraps the @apocaliss92/nodepetkit PetKit cloud client

## What it does

- **PetKit** (`provider-petkit`): Adopt PetKit smart feeders via the PetKit cloud account
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`, `pet-feeder`, `connection-test`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

