# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [0.1.5] - 2026-10-31

### Changed

- The Enpal box can be added as a Gateway device with a link to its local device page, next to its equipment.

## [0.1.4] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.1.3] - 2026-10-27

### Added

- Enpal solar box provider: InfluxDB 2.x source with the local device page as fallback, device adoption for PV, battery, grid, house and heat pump.
