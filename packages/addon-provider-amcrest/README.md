# Amcrest Provider

Amcrest/Dahua camera device provider addon for CamStack — Dahua CGI over HTTP(S) with digest auth (snapshot, RTSP catalog, PTZ, image/day-night config).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-amcrest` on npm.

## What it provides

- **Amcrest** (`provider-amcrest`): Amcrest/Dahua CGI camera provider — discovers RTSP streams, captures snapshots, and configures PTZ / image / day-night over HTTP digest auth. Category: providers.
  - Capabilities: `device-provider`, `stream-params`, `motion-zones`, `privacy-mask`, `day-night`, `image-settings`, `recording-onboard`, `videoclips`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Adding a device**

- Camera: Name
- Credentials: Username, Password
- Connection: Camera IP, Port, Use HTTPS

**Per-device settings**

- Connection: Camera IP, Port, Use HTTPS, Channel (1-based), Username, Password

## Requirements

- Placement: hub-only.
- Runtime dependencies installed with the addon: `onvif`.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
