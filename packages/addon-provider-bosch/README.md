# @camstack/addon-provider-bosch

Bosch smart-home device-provider addons for CamStack — SHC, Home Connect, and HomeCom cloud integrations (scaffold)

## What it does

- **Bosch Smart Home** (`bosch-shc`): Adopt Bosch Smart Home Controller (SHC) devices via account onboarding — scaffold
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`, `connection-test`.
- **Bosch Home Connect** (`bosch-home-connect`): Adopt Bosch Home Connect appliances via account onboarding — scaffold
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`, `connection-test`, `dishwasher`, `consumables`, `running-state`.
- **Bosch HomeCom** (`bosch-homecom`): Adopt Bosch HomeCom climate and water-heating devices via account onboarding — scaffold
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `device-adoption`, `connection-test`, `climate-control`, `water-heater`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- A CamStack hub. An agent is used only when the placement above allows it.

