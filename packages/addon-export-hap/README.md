# @camstack/addon-export-hap

HomeKit (HAP) exporter for CamStack devices. Publishes each exposed device as its own HomeKit accessory: cameras and doorbells with SRTP streaming, HomeKit Secure Video, motion, two-way audio, PTZ and battery; switches, lights, locks and sensors through a capability→service table.

## What it does

- **HomeKit Export** (`export-hap`): Publishes exposed CamStack devices to iOS Home over HomeKit (HAP) — cameras, doorbells, switches, lights, locks and sensors, each as its own accessory sharing one setup code.
  - Node placement: `hub-only`.
  - Capabilities: `device-export`, `videoclips`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

