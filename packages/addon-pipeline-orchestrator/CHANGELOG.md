# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.645] - 2026-10-31

### Changed

- Serves viewer 1.0.673

## [1.2.644] - 2026-10-31

### Changed

- Serves viewer 1.0.672 (notification targets: pick the account, then the device from a list).

## [1.2.643] - 2026-10-31

### Changed

- Forgetting a node now also removes its per-node pipeline settings and capability bindings and resets camera pins that named it to auto

## [1.2.642] - 2026-10-31

### Changed

- Closing a drawn polygon opens it in the zone form with the name field focused

## [1.2.641] - 2026-10-30

### Changed

- Finishing a zone on the camera frame now adds it on a hub served over plain http, and a rejected save is shown on the frame instead of being dropped
- Saving zone rules works on every camera and shows the error when the save is rejected

## [1.2.640] - 2026-10-29

### Changed

- Serves viewer 1.0.668: timeline hours line up with playback, and a track shows the name of the node it ran on

## [1.2.639] - 2026-10-29

### Added

- A newly paired agent joins detection, audio and ingest balancing by default; a role is off only when turned off

### Changed

- The pipeline-steps-not-provisioned warning now names the node and device in the log line

## [1.2.638] - 2026-10-28

### Changed

- Node alerts name the node by its display name and id

## [1.2.637] - 2026-10-28

### Changed

- Raises an alert when a node joining or leaving leaves cameras that a manual rebalance would move, with a one-click Rebalance now

## [1.2.636] - 2026-10-28

### Changed

- The hub serves viewer 1.0.665: a notification rule can ask you to confirm whether a detection was right

## [1.2.635] - 2026-10-28

### Changed

- The hub serves viewer 1.0.664: device values read the quantity field names, falling back to the old ones

## [1.2.634] - 2026-10-28

### Changed

- The hub serves viewer 1.0.663: the embed hides the assignment chip, shows short ages up to a week and follows the lang parameter

## [1.2.633] - 2026-10-28

### Changed

- The hub serves viewer 1.0.662: events embed tile settings and a track detail page

## [1.2.632] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.631] - 2026-10-27

### Added

- Pipeline Orchestrator: Hub-side camera-to-agent load balancer — tracks runner capacity and dispatches attachCamera calls to the optimal pipeline-runner instance.
- Provides the addon Pipeline Orchestrator.
