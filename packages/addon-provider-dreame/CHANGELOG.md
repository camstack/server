# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.180] - 2026-11-17

### Changed

- Robots declare their cloud device id as an identifier, so the same device from another integration can be matched.

## [0.2.179] - 2026-11-17

### Changed

- The battery camera now wakes through its low-power-sleep capability, so it is the one recognised as sleeping
- Re-sync is now offered through the device's own resync capability

## [0.2.178] - 2026-11-15

### Changed

- The connection-lost alert opens this integration's own page instead of the integrations list

## [0.2.177] - 2026-11-15

### Fixed

- The lawn mower reports its faults, including a low-temperature charging pause, on the error capability

## [0.2.176] - 2026-11-14

### Changed

- The robot's error is now served by the generic error capability; the separate Error sensor is removed

## [0.2.175] - 2026-11-14

### Changed

- select-style controls (program option, auto-switch, mower map) support next/previous/first/last stepping

## [0.2.174] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.2.173] - 2026-11-09

### Changed

- Internal: the instance form comments and specs follow the one instance door

## [0.2.172] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.171] - 2026-11-08

### Changed

- Comments and the addon template no longer name the retired addon-level settings hooks; they point at the scoped settings API.

## [0.2.170] - 2026-11-07

### Changed

- A Dreame vacuum no longer reports its clean-water tank as OK after docking while the tank is still low: the dock refresh reads the robot first, and a clean-water-empty error now forces the tank to low.

## [0.2.169] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.168] - 2026-11-06

### Changed

- The separate connection-test capability is gone; the integration's own Test button now checks the saved or drafted settings

## [0.2.167] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

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
