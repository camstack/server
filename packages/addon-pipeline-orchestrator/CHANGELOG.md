# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Pipeline orchestrator settings the addon writes itself go through the scoped settings API; changing the cluster roles re-derives ingest as before.

## [1.2.664] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.663] - 2026-11-06

### Changed

- The viewer web app is 1.0.685: notification targets pick their connection from a list.

## [1.2.662] - 2026-11-05

### Changed

- Pipeline orchestrator cluster settings are declared on the cluster scope of its capability; stored values unchanged

## [1.2.661] - 2026-11-05

### Changed

- The hub serves viewer web 1.0.684.

## [1.2.660] - 2026-11-05

### Changed

- Viewer 1.0.683: recent clips retry with backoff before showing an error, and the timeline shows a single fault notice.

## [1.2.659] - 2026-11-04

### Changed

- Serves viewer 1.0.682: the TV remote opens full screen.

## [1.2.658] - 2026-11-04

### Changed

- Serves viewer 1.0.681

## [1.2.657] - 2026-11-03

### Changed

- Serves viewer 1.0.680

## [1.2.656] - 2026-11-03

### Changed

- Serves viewer 1.0.679

## [1.2.655] - 2026-11-03

### Changed

- Node bindings, per-node agent settings and per-camera pipeline settings now live as one row per node or per camera, so forgetting a node or deleting a camera removes them; existing values are copied on first boot.

## [1.2.654] - 2026-11-03

### Changed

- Serves viewer 1.0.678
- The finished legacy-flags-to-bindings carry-over and its stored flag are removed

## [1.2.653] - 2026-11-02

### Changed

- An occupancy re-check burst that returns no result no longer counts as empty, so the re-check cadence is not disarmed by a silent burst

## [1.2.652] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.651] - 2026-11-01

### Changed

- Serves viewer 1.0.677

## [1.2.650] - 2026-11-01

### Changed

- Serves viewer 1.0.676

## [1.2.649] - 2026-11-01

### Changed

- Serves viewer 1.0.675

## [1.2.648] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.647] - 2026-11-01

### Changed

- Serves viewer 1.0.674

## [1.2.646] - 2026-10-31

### Changed

- Admin and addon pages use the library's form controls (Button, Input, Select, Textarea, Checkbox) instead of the browser's; no visible change beyond slightly tighter fields

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
