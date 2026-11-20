# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Camera reachability, the OSD snapshot and the floodlight state are read when the hub schedules it (every 30 s) instead of on the camera's own timers; after a floodlight command the hub shows the commanded value, then confirms it with a read 3 s and 10 s later

## [1.2.192] - 2026-11-20

### Changed

- A Hikvision camera's PTZ, autotrack, two-way audio and reboot features now follow the caps the camera registers, instead of a list the driver kept

## [1.2.191] - 2026-11-19

### Changed

- Siren no longer hand-sets the motion-trigger feature; it follows the bound cap

## [1.2.190] - 2026-11-18

### Changed

- Add device inside an integration offers the network scan

## [1.2.189] - 2026-11-17

### Changed

- The siren declares that it counts seconds and refuses a trigger in plays
- Cameras also declare their MAC, serial and IP as device identifiers (the hardware metadata is unchanged); a network read that fails keeps the MAC and IP declared before.

## [1.2.188] - 2026-11-16

### Changed

- Siren: timed trigger with a countdown, and motion-triggered audio alarm (VMD beep linkage); a siren toggled outside CamStack is not tracked until the next trigger or stop

## [1.2.187] - 2026-11-14

### Changed

- A network scan now marks a camera this provider already owns as already added instead of offering it again

## [1.2.186] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [1.2.185] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.184] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [1.2.183] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [1.2.182] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [1.2.181] - 2026-11-04

### Changed

- The Hikvision integration is now a typed integration instance and the Hikvision devices are claimed to it

## [1.2.180] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.179] - 2026-10-30

### Changed

- Cameras are found by the shared network scan (WS-Discovery and an ISAPI probe confirmed with the scan credentials); the scan-options subnet field is gone

## [1.2.178] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.177] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.176] - 2026-10-27

### Added

- Hikvision Provider: Hikvision camera device provider addon for CamStack — ISAPI over HTTP(S) with digest auth (snapshot, alarm stream, RTSP discovery).
- Provides the addon Hikvision.
