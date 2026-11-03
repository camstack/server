# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The viewer's shipped log is tagged source=viewer with the authenticated user, platform, app version and a per-launch session, so the Logs page and MCP can filter it by tag

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
