# @camstack/addon-provider-reolink

Reolink camera device provider addon for CamStack — native Baichuan protocol

## What it does

- **Reolink** (`provider-reolink`): Native Baichuan protocol connection to Reolink cameras — direct Annex-B push, no RTSP intermediary
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `stream-params`, `recording-onboard`, `motion-zones`, `privacy-mask`, `log-channels`, `failure-contribution`, `stream-signals`, `videoclips`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `werift`, `zod`.
- Runtime dependencies the node resolves: `@apocaliss92/nodelink-js`, `werift`.
- A CamStack hub. An agent is used only when the placement above allows it.

