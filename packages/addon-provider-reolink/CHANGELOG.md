# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.216] - 2026-10-31

### Changed

- The NVR / Home Hub can be added as a Gateway device (reboot, web interface link) next to its channel cameras.

## [1.2.215] - 2026-10-31

### Changed

- A Reolink NVR / Home Hub is now its own integration: add it from Integrations (its password is kept in the keychain), its channels are adopted as cameras, and an existing Hub device is migrated automatically on first start with its cameras and their settings kept.
- An integration instance can have its own settings form: a Reolink NVR / Home Hub shows its connection only, the default integration keeps the full form

## [1.2.214] - 2026-10-30

### Changed

- Discovery scans every subnet the network scan covers; the network CIDR field in the scan options is gone

## [1.2.213] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.212] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.211] - 2026-10-27

### Added

- Reolink Provider: Reolink camera device provider addon for CamStack — native Baichuan protocol.
- Provides the addon Reolink.
