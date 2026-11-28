# Unraid Provider

Unraid device-provider addon for Dominevo — the server as a Gateway and an instance Container with array, disk and notification entities; each Docker container and VM adopted as its own device.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@dominevo/addon-provider-unraid` on npm.

## What it provides

- **Unraid** (`provider-unraid`): Add an Unraid server as an integration over its local GraphQL API and adopt the server itself as a workload Host (with its WebGUI link, array, disks and notifications), and one workload device per Docker container and VM, each with its own state, controls and power switch. Category: providers.
  - Capabilities: `device-provider`, `integration-instances`, `device-adoption`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Connection**

- Connection: Host / IP, Port, Use HTTPS, Allow self-signed certificate, API key, Poll interval (ms)

## Requirements

- Placement: hub-only.
- A Dominevo hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/dominevo/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->

## Finding the server on the network

A network scan asks every host `{__typename}` on `/graphql` — port 80, and port 443 over TLS for a
server that serves only https — and offers each host that answers like an Unraid API as an
integration to set up, named after its address, with host, port and scheme filled in. The API key
is still asked when the integration is set up. A server whose host an integration already uses is
not offered again.
