# @camstack/addon-provider-amcrest

Amcrest/Dahua camera device provider addon for CamStack — Dahua CGI over HTTP(S) with digest auth (snapshot, RTSP catalog, PTZ, image/day-night config)

## What it does

- **Amcrest** (`provider-amcrest`): Amcrest/Dahua CGI camera provider — discovers RTSP streams, captures snapshots, and configures PTZ / image / day-night over HTTP digest auth
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `stream-params`, `motion-zones`, `privacy-mask`, `day-night`, `image-settings`, `recording-onboard`, `videoclips`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `zod`.
- Runtime dependencies the node resolves: `onvif`.
- A CamStack hub. An agent is used only when the placement above allows it.

