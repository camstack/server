# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.1.13] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.1.12] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.1.11] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.1.10] - 2026-11-05

### Changed

- Internal: the connection form comment names the instance form; no behaviour change.

## [0.1.9] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.1.8] - 2026-11-04

### Changed

- Enpal boxes are now typed records under their integration; the InfluxDB token stays in the keychain and the legacy settings rows are moved and cleared on first start

## [0.1.7] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.1.6] - 2026-11-01

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
