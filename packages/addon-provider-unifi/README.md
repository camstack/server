# UniFi Network Provider

UniFi Network controller device-provider addon for CamStack — local-controller infra switches/APs (as containers) + network-client presence. No cameras.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-unifi` on npm.

## What it provides

- **UniFi Network** (`provider-unifi`): Add a UniFi Network controller as an integration (the connection and credentials are its settings); it adopts each console as the workload Host (with restart and its admin link), infra devices (switches / APs / gateways) as hosts exposing per-port PoE, restart, LED and CPU/temp/clients sensors, plus network clients as presence. Cameras are not in scope. Category: providers.
  - Capabilities: `device-provider`, `integration-instances`, `device-adoption`.

## Requirements

- Placement: hub-only.
- Python: UniFi Network installs `python/requirements.txt` into its own environment.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->

## Finding the console on the network

A network scan broadcasts the Ubiquiti discovery probe (UDP port 10001) and offers each UniFi OS
console (Dream Machine, Dream Router, Cloud Gateway, Cloud Key, Express …) as an integration to
set up, with its host filled in. The API key is still asked when the integration is set up.
Access points and switches answer the same probe but are never offered: they arrive as devices of
the adopted console. A console whose host an integration already uses is not offered again.
