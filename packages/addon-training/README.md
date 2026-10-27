# @camstack/addon-training

Cloud training for CamStack: fine-tune the root detector on your own frames, on your own GPU-cloud account

## What it does

- **Training** (`training`): Fine-tune the root detector on your own annotated frames in a GPU cloud you choose, compare it with the model you run, and register it in Model Studio only when you say so
  - Node placement: `hub-only`.
  - Capabilities: `training`, `addon-pages-source`.
- **Modal** (`training-modal`): Runs CamStack training jobs on your Modal account (modal.com, $30 of free credit a month on the Starter plan). Inert until you enter a Modal token
  - Node placement: `hub-only`.
  - Capabilities: `training-provider`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`.
- A CamStack hub. An agent is used only when the placement above allows it.

