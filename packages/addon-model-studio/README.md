# @camstack/addon-model-studio

Custom detection model registry, conversion & distribution for CamStack

## What it does

- **Model Studio** (`model-studio`): Register, manipulate and distribute custom detection models
  - Node placement: `any-node`, runner group `ml`.
  - Capabilities: `custom-model-registry`, `model-convert`, `addon-pages-source`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `react`, `react-dom`.
- A CamStack hub. An agent is used only when the placement above allows it.

