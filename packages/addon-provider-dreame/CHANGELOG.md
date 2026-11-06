# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.166] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.165] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.164] - 2026-11-04

### Changed

- Dreame accounts are now typed integration instances; existing accounts are migrated on the first start, nothing to re-enter

## [0.2.163] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.2.162] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [0.2.161] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.160] - 2026-10-28

### Fixed

- A docked Dreame robot at rest no longer shows Error 68

## [0.2.159] - 2026-10-27

### Added

- An alert when the Dreame sign-in is rejected; the clean-water tank is re-read every 3 minutes and on every state change

## [0.2.158] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.157] - 2026-10-27

### Added

- Dreame Provider: Dreame robot-vacuum / lawn-mower device-provider addon for CamStack — wraps the @apocaliss92/nodedreame Dreamehome cloud client.
- Provides the addon Dreame.
