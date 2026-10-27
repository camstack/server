# Post-Analysis

Post-Analysis bundle — enrichment, embedding-encoder, pipeline-analytics. Multi-entry npm package shipping addons that consume pipeline output. Enrichment, embedding encoder, and pipeline analytics — consumers of pipeline output.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-post-analysis` on npm.

## What it provides

- **Embedding Encoder** (`embedding-encoder`): ONNX-Runtime image-embedding encoder. Produces semantic vectors from detection crops for similarity search + scene-state tracking. Category: analytics.
  - Capabilities: `embedding-encoder`.
- **Pipeline Analytics** (`pipeline-analytics`): Zone analytics + audio metrics aggregator. Consumes pipeline events to surface per-camera zone counters and audio-level histograms. Category: analytics.
  - Capabilities: `device-removal-hook`, `pipeline-analytics`, `notification-rules`, `zone-analytics`, `audio-metrics`, `addon-widgets-source`, `face-gallery`, `plate-gallery`, `scene-monitor`, `failure-contribution`, `storage-occupancy`.

## Requirements

- Placement: any-node.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/notifications.md](https://github.com/camstack/server/blob/main/docs/architecture/notifications.md)
- [docs/architecture/post-analysis.md](https://github.com/camstack/server/blob/main/docs/architecture/post-analysis.md)
- [docs/architecture/cloud-training.md](https://github.com/camstack/server/blob/main/docs/architecture/cloud-training.md)
- [docs/architecture/osd-manager.md](https://github.com/camstack/server/blob/main/docs/architecture/osd-manager.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
