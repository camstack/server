# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.158] - 2026-11-05

### Changed

- Internal: the connection form comment names the instance form; no behaviour change.

## [0.2.157] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.156] - 2026-11-04

### Changed

- Unraid servers are now typed records under their integration; the API key stays in the keychain and the legacy settings rows are moved and cleared on first start

## [0.2.155] - 2026-11-01

### Changed

- The Unraid integration shows the Unraid brand icon.
- Unraid integrations now connect to the Unraid API with the configured API key and report the array, disks, docker containers, CPU and active notifications
- Unraid integrations now connect to the Unraid API with the configured API key and report the array, disks, docker containers, CPU and active notifications (an option accepts a self-signed certificate; a failed CPU or container-stats sample reads as unknown, not 0)

## [0.2.154] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.2.153] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

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
