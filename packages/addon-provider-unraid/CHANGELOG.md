# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.152] - 2026-11-01

### Changed

- Unraid is now added as an integration: the server host and API key are the integration's settings, and the server appears as a Gateway next to its instance device instead of a Hub.
- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.151] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.150] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.149] - 2026-10-27

### Added

- Unraid Provider: Unraid device-provider addon for CamStack — one Container per Unraid instance fanning out array, disk, docker and notification entities.
- Provides the addon Unraid.
