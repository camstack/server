# @camstack/addon-pipeline

Pipeline bundle — runner, detection, motion, audio + stream broker. Multi-entry npm package shipping pipeline addons under a single bundle.

## What it does

- **Pipeline Runner** (`pipeline-runner`): Per-node detection scheduler — manages frame queues, semaphore, motion drain, and inference dispatch for cameras assigned by the orchestrator
  - Node placement: `any-node`, runner group `detection`.
  - Capabilities: `pipeline-runner`, `load-contribution`, `failure-contribution`.
- **Detection Pipeline** (`detection-pipeline`): Unified detection pipeline — object detection, face/plate recognition, classification, segmentation
  - Node placement: `any-node`, runner group `detection`.
  - Capabilities: `pipeline-executor`, `detection-pipeline`, `load-contribution`.
- **Motion Detection (WASM)** (`motion-wasm`): WASM-accelerated motion detection with blur, dilation, and connected component labeling
  - Node placement: `any-node`, runner group `detection`.
  - Capabilities: `motion-detection`.
- **Audio Analyzer** (`audio-analyzer`): Audio level metering (dB/RMS) with optional classification
  - Node placement: `any-node`.
  - Capabilities: `audio-analyzer`, `audio-analysis`.
- **Stream Broker** (`stream-broker`).
  - Node placement: `any-node`.
  - Capabilities: `device-removal-hook`, `stream-broker`, `camera-streams`, `webrtc-session`, `addon-widgets-source`, `log-channels`, `load-contribution`.
- **Recorder** (`recorder`): Continuous, local, filesystem-native camera recording — passthrough ffmpeg segmenter per profile with a RAM index and HLS variant/master playlists
  - Node placement: `any-node`.
  - Capabilities: `device-removal-hook`, `recording`, `recording-archive`, `videoclips`, `recording-export`, `storage-evictable`, `storage-occupancy`, `load-contribution`.

## Settings

Settings this addon exposes are edited from System → Addons → this addon → Settings when they apply to the whole cluster, and from the device page when they belong to one device. A password field is stored in the keychain.

## Requirements

- Peer packages already on the node: `@camstack/types`, `react`, `react-dom`, `werift`.
- Runtime dependencies the node resolves: `werift`.
- A CamStack hub. An agent is used only when the placement above allows it.

