# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.159] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update
- The separate connection-test capability is gone; the integration's own Test button now checks the saved or drafted settings

## [0.2.158] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.157] - 2026-11-05

### Changed

- Dreo: the Test button on an account integration now signs in to the Dreo cloud, using the saved password when it is not retyped

## [0.2.156] - 2026-11-05

### Changed

- The Dreo integration offers the Test action it implements.

## [0.2.155] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.154] - 2026-11-04

### Changed

- Dreo accounts are now typed records under their integration; the password stays in the keychain and the legacy settings rows are moved and cleared on first start

## [0.2.153] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.2.152] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [0.2.151] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.150] - 2026-10-27

### Added

- An alert when the Dreo sign-in is rejected

## [0.2.149] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.148] - 2026-10-27

### Added

- Dreo Provider: Dreo smart-device (fan / air-circulator / purifier / heater / humidifier) device-provider addon for CamStack — wraps the @apocaliss92/nodedreo Dreo cloud client (REST + WebSocket).
- Provides the addon Dreo.
