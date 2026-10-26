# @camstack/addon-pipeline-orchestrator

Hub-side camera-to-agent load balancer — tracks runner capacity and dispatches attachCamera calls to the optimal pipeline-runner instance

## What it does

- **Pipeline Orchestrator** (`pipeline-orchestrator`): Hub-side camera-to-agent load balancer with L1 manual affinity, L2 capacity, and L3 hardware-aware dispatch
  - Node placement: `hub-only`.
  - Capabilities: `pipeline-orchestrator`, `camera-pipeline-config`, `zones`, `zone-rules`, `addon-widgets-source`, `viewer-ui`, `display-palette`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `react`, `react-dom`.
- A CamStack hub. An agent is used only when the placement above allows it.

