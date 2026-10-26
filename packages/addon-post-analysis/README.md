# @camstack/addon-post-analysis

Post-Analysis bundle — enrichment, embedding-encoder, pipeline-analytics. Multi-entry npm package shipping addons that consume pipeline output.

## What it does

- **Embedding Encoder** (`embedding-encoder`): ONNX-Runtime image-embedding encoder. Produces semantic vectors from detection crops for similarity search + scene-state tracking.
  - Node placement: `any-node`.
  - Capabilities: `embedding-encoder`.
- **Pipeline Analytics** (`pipeline-analytics`): Zone analytics + audio metrics aggregator. Consumes pipeline events to surface per-camera zone counters and audio-level histograms.
  - Node placement: `any-node`.
  - Capabilities: `device-removal-hook`, `pipeline-analytics`, `notification-rules`, `zone-analytics`, `audio-metrics`, `addon-widgets-source`, `face-gallery`, `plate-gallery`, `scene-monitor`, `failure-contribution`, `storage-occupancy`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `react`, `react-dom`.
- A CamStack hub. An agent is used only when the placement above allows it.

