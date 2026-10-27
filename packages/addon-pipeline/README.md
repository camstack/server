# Pipeline

Pipeline bundle — runner, detection, motion, audio + stream broker. Multi-entry npm package shipping pipeline addons under a single bundle. Detection, motion, audio + stream broker.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-pipeline` on npm.

## What it provides

- **Pipeline Runner** (`pipeline-runner`): Per-node detection scheduler — manages frame queues, semaphore, motion drain, and inference dispatch for cameras assigned by the orchestrator. Category: pipeline.
  - Capabilities: `pipeline-runner`, `load-contribution`, `failure-contribution`.
- **Detection Pipeline** (`detection-pipeline`): Unified detection pipeline — object detection, face/plate recognition, classification, segmentation. Category: pipeline.
  - Capabilities: `pipeline-executor`, `detection-pipeline`, `load-contribution`.
- **Motion Detection** (`motion-wasm`): WASM-accelerated motion detection with blur, dilation, and connected component labeling. Category: pipeline.
  - Capabilities: `motion-detection`.
- **Audio Analyzer** (`audio-analyzer`): Audio level metering (dB/RMS) with optional classification. Category: pipeline.
  - Capabilities: `audio-analyzer`, `audio-analysis`.
- **Stream Broker** (`stream-broker`): Category: pipeline.
  - Capabilities: `device-removal-hook`, `stream-broker`, `camera-streams`, `webrtc-session`, `addon-widgets-source`, `log-channels`, `load-contribution`.
- **Recorder** (`recorder`): Continuous, local, filesystem-native camera recording — passthrough ffmpeg segmenter per profile with a RAM index and HLS variant/master playlists. Category: pipeline.
  - Capabilities: `device-removal-hook`, `recording`, `recording-archive`, `videoclips`, `recording-export`, `storage-evictable`, `storage-occupancy`, `load-contribution`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Cluster recording: Recording node, Hub host (cross-node)

## Requirements

- Pipeline Runner: any-node (runner group `detection`).
- Detection Pipeline: any-node (runner group `detection`).
- Motion Detection: any-node (runner group `detection`).
- Audio Analyzer: any-node.
- Stream Broker: any-node.
- Recorder: any-node.
- Runtime dependencies installed with the addon: `werift`.
- Python: Detection Pipeline installs `python/requirements.txt` into its own environment.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/data-planes.md](https://github.com/camstack/server/blob/main/docs/architecture/data-planes.md)
- [docs/architecture/detection-execution.md](https://github.com/camstack/server/blob/main/docs/architecture/detection-execution.md)
- [docs/architecture/load-ledger.md](https://github.com/camstack/server/blob/main/docs/architecture/load-ledger.md)
- [docs/architecture/benchmark.md](https://github.com/camstack/server/blob/main/docs/architecture/benchmark.md)
- [packages/addon-pipeline/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-pipeline/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
