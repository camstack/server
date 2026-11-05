# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.155] - 2026-11-04

### Changed

- UniFi controllers are now typed records under their integration; the API key and password stay in the keychain and the legacy settings rows are moved and cleared on first start

## [0.2.154] - 2026-11-01

### Changed

- The UniFi integration shows the Ubiquiti brand icon.
- Connect a UniFi OS console through its API key (Network Integration API): infrastructure devices and client presence are read, restart and port power-cycle work; PoE toggle and LED are not offered by that API. New option to accept the console's self-signed certificate.

## [0.2.153] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.2.152] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [0.2.151] - 2026-11-01

### Changed

- UniFi is now added as an integration: the controller connection and credentials are the integration's settings, and the controller appears as a Gateway beside its infra devices and clients instead of a Hub.
- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.150] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.149] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.148] - 2026-10-27

### Added

- UniFi Network Provider: UniFi Network controller device-provider addon for CamStack — local-controller infra switches/APs (as containers) + network-client presence. No cameras.
- Provides the addon UniFi Network.
