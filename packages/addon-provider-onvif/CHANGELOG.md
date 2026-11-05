# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.155] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [1.2.154] - 2026-11-04

### Changed

- ONVIF is now an integration instance of its own and runs on the hub only; cameras that named no integration are claimed to it on first start

## [1.2.153] - 2026-11-03

### Changed

- The addon-wide default username and password are removed and the stored password is cleared from the keychain; discovered cameras are no longer pre-filled with them, so enter each camera's credentials when adopting it

## [1.2.152] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.151] - 2026-10-30

### Changed

- Cameras are found by the shared network scan (WS-Discovery); the discovery timeout setting is gone

## [1.2.150] - 2026-10-27

### Changed

- Shown as "ONVIF" (was "ONVIF Camera Provider").

## [1.2.149] - 2026-10-27

### Added

- ONVIF: ONVIF camera device provider addon for CamStack.
- Provides the addon ONVIF.
