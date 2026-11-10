# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.157] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [1.2.156] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [1.2.155] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.154] - 2026-11-06

### Changed

- The RTSP integration no longer registers a separate connection test; a camera's stream URL is still probed when the camera is created.

## [1.2.153] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [1.2.152] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [1.2.151] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [1.2.150] - 2026-11-04

### Changed

- The rtsp integration is now a typed integration instance and its devices are claimed to it

## [1.2.149] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.148] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.147] - 2026-10-27

### Added

- RTSP Provider: Generic RTSP camera device provider addon for CamStack.
- Provides the addon RTSP.
