# @camstack/addon-benchmark

Benchmark page: measure what one node can carry (the orchestrator's node benchmark), inspect one image or one sound

## What it does

- **Benchmark** (`benchmark`): Node benchmark, image and audio inspection
  - Node placement: `hub-only`, runner group `ml`.
  - Capabilities: `addon-pages-source`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `react`, `react-dom`.
- A CamStack hub. An agent is used only when the placement above allows it.

