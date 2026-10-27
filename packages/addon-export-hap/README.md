# HomeKit Export

HomeKit (HAP) exporter for CamStack devices. Publishes each exposed device as its own HomeKit accessory: cameras and doorbells with SRTP streaming, HomeKit Secure Video, motion, two-way audio, PTZ and battery; switches, lights, locks and sensors through a capability→service table.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-export-hap` on npm.

## What it provides

- **HomeKit Export** (`export-hap`): Publishes exposed CamStack devices to iOS Home over HomeKit (HAP) — cameras, doorbells, switches, lights, locks and sensors, each as its own accessory sharing one setup code. Category: exports.
  - Capabilities: `device-export`, `videoclips`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
