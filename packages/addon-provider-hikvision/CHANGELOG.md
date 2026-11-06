# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
