# Cloud Training

Cloud training for CamStack: fine-tune the root detector on your own frames, on your own GPU-cloud account.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-training` on npm.

## What it provides

- **Training** (`training`): Fine-tune the root detector on your own annotated frames in a GPU cloud you choose, compare it with the model you run, and register it in Model Studio only when you say so. Category: system.
  - Capabilities: `training`, `addon-pages-source`.
- **Modal** (`training-modal`): Runs CamStack training jobs on your Modal account (modal.com, $30 of free credit a month on the Starter plan). Inert until you enter a Modal token. Category: system.
  - Capabilities: `training-provider`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/cloud-training.md](https://github.com/camstack/server/blob/main/docs/architecture/cloud-training.md)
- [packages/addon-training/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-training/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
