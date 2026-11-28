# Bosch

Bosch smart-home device-provider addons for Dominevo — SHC, Home Connect, and HomeCom cloud integrations (scaffold).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@dominevo/addon-provider-bosch` on npm.

## What it provides

- **Bosch Smart Home** (`bosch-shc`): Adopt Bosch Smart Home Controller (SHC) devices via account onboarding — scaffold. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`, `integration-instances`.
- **Bosch Home Connect** (`bosch-home-connect`): Adopt Bosch Home Connect appliances via account onboarding — scaffold. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`, `integration-instances`, `dishwasher`, `consumables`, `running-state`.
- **Bosch HomeCom** (`bosch-homecom`): Adopt Bosch HomeCom climate and water-heating devices via account onboarding — scaffold. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`, `integration-instances`, `climate-control`, `water-heater`, `heat-pump-status`, `heat-pump-control`.

## Requirements

- Placement: hub-only.
- Python: Bosch HomeCom installs `python/requirements.txt` into its own environment.
- A Dominevo hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-provider-bosch-homecom.md](https://github.com/dominevo/server/blob/main/docs/addons/addon-provider-bosch-homecom.md)
- [docs/addons/addon-provider-bosch-home-connect.md](https://github.com/dominevo/server/blob/main/docs/addons/addon-provider-bosch-home-connect.md)
- [docs/architecture/device-model.md](https://github.com/dominevo/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
