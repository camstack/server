# Wyze Provider

Wyze camera device-provider addon for CamStack — wraps the @apocaliss92/wyze-bridge-js P2P/DTLS client, feeding the stream-broker via the pull-rfc4571 lazy-publish path (a structural twin of addon-provider-reolink).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-wyze` on npm.

## What it provides

- **Wyze** (`provider-wyze`): Adopt Wyze cameras over the local P2P/DTLS protocol via Wyze-cloud discovery — H264/H265 + audio into the stream-broker, snapshot, motion and two-way audio. Category: providers.
  - Capabilities: `device-provider`, `device-adoption`, `stream-params`, `connection-test`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Stream: Resolution, Bitrate, Motion source

**Adding a device**

- Camera: Name
- P2P parameters: MAC, P2P UID, ENR (encryption key), Local IP, Product model
- Stream: Resolution, Bitrate, Motion source

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
