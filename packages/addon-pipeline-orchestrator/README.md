# Pipeline Orchestrator

Hub-side camera-to-agent load balancer — tracks runner capacity and dispatches attachCamera calls to the optimal pipeline-runner instance.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-pipeline-orchestrator` on npm.

## What it provides

- **Pipeline Orchestrator** (`pipeline-orchestrator`): Hub-side camera-to-agent load balancer with L1 manual affinity, L2 capacity, and L3 hardware-aware dispatch. Category: pipeline.
  - Capabilities: `pipeline-orchestrator`, `camera-pipeline-config`, `zones`, `zone-rules`, `addon-widgets-source`, `viewer-ui`, `display-palette`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/inference-devices.md](https://github.com/camstack/server/blob/main/docs/architecture/inference-devices.md)
- [docs/architecture/detection-execution.md](https://github.com/camstack/server/blob/main/docs/architecture/detection-execution.md)
- [docs/architecture/benchmark.md](https://github.com/camstack/server/blob/main/docs/architecture/benchmark.md)
- [docs/architecture/ui.md](https://github.com/camstack/server/blob/main/docs/architecture/ui.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
