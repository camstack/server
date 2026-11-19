# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.668] - 2026-11-19

### Changed

- Stateless runs and benchmarks without an explicit device no longer use the node's default engine when it is excluded: they run on an eligible device or are refused with 'no-eligible-device'.
- A derived stream's effective encode can be previewed before it runs, computed by the same function the broker uses to start it; a height-only profile now actually resizes (the other side follows the source aspect).
- A derived profile or egress asking for the source codec keeps the camera's own codec (H.265 stays H.265).
- Derived-stream editor: resize, video codec, audio and frame rate are separate switches that combine, bitrate and raw ffmpeg args sit under Expert, and a Final result panel shows the encode the server will run.
- An NVIDIA image now installs onnxruntime-gpu from its wheelhouse for the ONNX engine instead of the CPU wheel, so CUDA can be offered.

### Fixed

- Derived streams no longer blur at every keyframe: the encoder now targets 80% of the bitrate cap, never upsamples fps above the source, raises a too-low bitrate to a floor for its resolution, and a suspended derived stream no longer logs a false 'push source stalled'.
- A derived stream that names only a height now gets the same bitrate and floor as the equivalent width x height, and its effective encode is reported in the broker stats.
- The derived-stream audio section offers G.711 PCMU and PCMA again

## [1.2.667] - 2026-11-18

### Changed

- An inference device OpenVINO cannot enumerate (for example an Intel iGPU the compute runtime no longer supports) is now reported down with the reason no-gpu-device instead of failing every load behind a retry backoff

### Fixed

- A derived stream's FPS, bitrate, width and height fields now save on blur or Enter instead of every keystroke, and can be cleared to follow the source

## [1.2.666] - 2026-11-18

### Added

- A detection step switched off on an accelerator is never run there: it moves to another accelerator on the node, or is skipped when none may run it.

## [1.2.665] - 2026-11-18

### Changed

- CPU-only nodes default to YOLOv9-s @320 for object detection instead of YOLO26 nano.
- Motion detection now judges a moving subject as a whole by default, so a person walking in view is no longer dropped as small fragments; cameras with a Min Area value you set keep their per-region bar.

## [1.2.663] - 2026-11-18

### Changed

- The inference pool log now names the device the ONNX session actually runs on (device=cpu when only the CPU provider bound), not the device it was asked for.
- An NVIDIA card no longer hides the Intel iGPU from the inference devices, and counts as a GPU only once it can run inference.

## [1.2.662] - 2026-11-18

### Changed

- Scrubbing recordings of high-bitrate cameras is fast again.

## [1.2.661] - 2026-11-18

### Changed

- A sensor-triggered recording starts only from what the device reported, never from a command still waiting for confirmation.

## [1.2.660] - 2026-11-17

### Changed

- Object detection now runs on a crop around motion when subjects are small in a high-resolution frame (same inference count, a full frame at least once a second); the choice is on each frame's pipeline trace.
- Object detection no longer magnifies a near subject into the crop around motion: a subject already seen large keeps the full frame, and a crop that misses a known subject hands the next frame to the full frame

## [1.2.659] - 2026-11-17

### Changed

- A phantom cell is no longer armed or cleared by a track too brief to judge (under 1.5 s or 4 sightings); the skip is logged per camera

## [1.2.658] - 2026-11-17

### Changed

- Prebuffer, stall tolerance, wake-on-play and the recorder's wake now apply to cameras that sleep, not to every device that reports a battery
- The stream broker and the recorder read a sleeping camera's state from its sleep status, not its battery status

## [1.2.657] - 2026-11-17

### Changed

- Playing an SD-card clip in the viewer now carries your authorisation to wake a sleeping battery camera, so the clip plays instead of being refused as sleeping; background reads still never wake it.

## [1.2.656] - 2026-11-16

### Changed

- The pipeline runner now reports, per camera, how many native crops it failed to produce, so the health digest can show the change per interval

## [1.2.655] - 2026-11-15

### Changed

- A clip opened from the viewer with the clip intent plays without dialling or waking the camera. Switching back to live renegotiates the session as a normal live one (wake, warm-up, the camera's codec), and an H.265 clip renegotiates at H.265 instead of playing black.

## [1.2.654] - 2026-11-15

### Changed

- Fix: a camera with no elected device now plans root-model supplies on the node's real default detection model instead of the flat yolo26n
- Apple Neural Engine nodes now default to the yolov9m 640 detector (better recall on distant people)

## [1.2.653] - 2026-11-15

### Changed

- Fixed false 'no recordings' gaps on the timeline when part of an hour's footage lives on a second recordings root

## [1.2.652] - 2026-11-14

### Changed

- Rebuilt against updated dependencies.

## [1.2.651] - 2026-11-12

### Fixed

- An on-demand camera stream that stops because nobody is watching no longer raises stream offline or stream online.
- A battery camera notifies a connection error only when the whole camera stays down for the sustained outage window. A dial that recovers inside that window, or a source that fails while another source of the camera delivers, does not.
- A held battery connection error is dropped when the camera goes back to sleep, so a wake that fails and then sleeps does not notify stream offline.

## [1.2.650] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.649] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [1.2.648] - 2026-11-08

### Changed

- Comments and the addon template no longer name the retired addon-level settings hooks; they point at the scoped settings API.

## [1.2.647] - 2026-11-07

### Changed

- The Inference executor form of another node now shows the suggested defaults of that node's own hardware, served through the scoped settings overlay
- The audio engine form of a node offers only the backends that node can run, served through the scoped settings API

## [1.2.646] - 2026-11-07

### Changed

- The pipeline runner reads the crop convention, native-lease knobs and cluster step models from the orchestrator's scoped cluster values (same keys, same refresh)

### Fixed

- A change to the scene tile RAM alone now reaches the decode workers without a restart.

## [1.2.645] - 2026-11-07

### Changed

- Internal: its stored state is now read and written through the typed state API under the same storage key; nothing changes for the operator.

## [1.2.644] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.643] - 2026-11-06

### Changed

- Recorder legacy collection-name constants removed

## [1.2.642] - 2026-11-05

### Changed

- Detection pipeline settings are declared by the owning capability (executor knobs per node, substitution readout cluster-wide); stored values unchanged

## [1.2.641] - 2026-11-05

### Changed

- Audio analyzer, pipeline runner and stream broker declare their settings through the scoped hooks; the settings forms and stored values are unchanged.
- Recorder node and hostname settings are declared on the cluster hook; the form and stored values are unchanged.

## [1.2.640] - 2026-11-03

### Changed

- The viewer's shipped log is tagged source=viewer with the authenticated user, platform, app version and a per-launch session, so the Logs page and MCP can filter it by tag
- A derived stream now keeps its source's frame cadence and IDR interval and sizes its rate buffer to a whole GOP, fixing the once-a-second flicker at a low bitrate cap
- The stream broker's codec and geometry dropdowns are readable in dark mode (the editor fields used a colour the theme does not define)

## [1.2.639] - 2026-11-03

### Changed

- The runner's tuning fields, the broker's RTSP port and the audio analyzer's backend are now per-node settings; each node's existing value is copied to its node row, and the two duplicate decode-limit settings fold into one (a node's own value wins over the cluster value; two disagreeing values at one level are reported and left as they are)

## [1.2.638] - 2026-11-02

### Changed

- New debug channel debug.stream-broker-rtp: RTP subscribers attaching and detaching per camera, readable from Logs > Watch.

## [1.2.637] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.636] - 2026-10-31

### Changed

- Admin and addon pages use the library's form controls (Button, Input, Select, Textarea, Checkbox) instead of the browser's; no visible change beyond slightly tighter fields

## [1.2.635] - 2026-10-30

### Changed

- Adding a non-camera device no longer makes every stream broker log a failed stream-catalog pull.

## [1.2.634] - 2026-10-29

### Changed

- Alexa live-view sessions log the peer's ICE candidates and whether it ever sent a connectivity check, to diagnose sessions that never connect

## [1.2.633] - 2026-10-28

### Changed

- A battery camera waking up for an event no longer reports its stream offline and online again

## [1.2.632] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.631] - 2026-10-27

### Changed

- Motion detection is shown as "Motion Detection" (was "Motion Detection (WASM)").

## [1.2.630] - 2026-10-27

### Added

- Pipeline: Pipeline bundle — runner, detection, motion, audio + stream broker. Multi-entry npm package shipping pipeline addons under a single bundle.
- Provides the addons Pipeline Runner, Detection Pipeline, Motion Detection, Audio Analyzer, Stream Broker, Recorder.
