# RTSP Provider

Generic RTSP camera device provider addon for CamStack.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-rtsp` on npm.

## What it provides

- **RTSP** (`provider-rtsp`): Direct connection to cameras via RTSP URL. Category: providers.
  - Capabilities: `device-provider`, `connection-test`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Adding a device**

- Camera: Name
- RTSP Streams: RTSP stream URL
- Snapshot: Snapshot URL
- Credentials: Username, Password

**Per-device settings**

- RTSP Streams: RTSP stream URL
- Snapshot: Snapshot URL
- Credentials: Username, Password

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
