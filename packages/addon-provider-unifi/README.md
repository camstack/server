# UniFi Network Provider

UniFi Network controller device-provider addon for CamStack — local-controller infra switches/APs (as containers) + network-client presence. No cameras.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-unifi` on npm.

## What it provides

- **UniFi Network** (`provider-unifi`): Adopt a UniFi Network controller over the local network: infra devices (switches / APs / gateways) as containers exposing per-port PoE, restart, LED and CPU/temp/clients sensors, plus network clients as presence. Cameras are not in scope. Category: providers.
  - Capabilities: `device-provider`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
