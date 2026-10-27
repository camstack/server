# @camstack/addon-decoder-nodeav

Standalone in-process node-av decoder addon for CamStack

## What it does

- **Video Decoder** (`decoder-nodeav`): The node's decoder-hwaccel probe (decoder cap: getInfo / reprobeHwaccel) and the node-av audio codec (encode/decode + resample) for the audio-codec cap.
  - Node placement: `any-node`.
  - Capabilities: `decoder`, `audio-codec`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

