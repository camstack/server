# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The CCU network scan now finds a CCU that answers the probe with a JSON-RPC error, a WebUI username alone (empty password) now unlocks device names, and a missing-names warning is logged.

## [1.2.171] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.170] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.169] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.168] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.167] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.166] - 2026-10-31

### Changed

- New Homematic CCU page under Administration: CCU version, interface health and duty cycle, and service messages you can acknowledge.
- Homematic CCU page: a Devices tab with firmware, signal, duty cycle, low battery, unreachable, config pending and sabotage per device.
- Homematic CCU page: heating tab lists groups and thermostats and creates, edits and deletes heating groups behind a confirmation
- Homematic CCU page: pairing tab opens learn mode on BidCos-RF and HmIP-RF and lists new devices live; devices can be deleted from the CCU with a factory-reset option, each behind a confirmation
- Homematic CCU page: edit a device channel's MASTER parameters (changed values only, behind a confirmation)

## [1.2.165] - 2026-10-31

### Changed

- Uses nodehomematic 0.5.1.

## [1.2.164] - 2026-10-30

### Changed

- The Homematic CCU is found by the shared network scan, including on other subnets

## [1.2.163] - 2026-10-30

### Changed

- A Homematic CCU3 / RaspberryMatic is now added as an integration (host, interfaces, optional WebUI login) with a connection test and LAN discovery, and appears as a Gateway device with a link to its WebUI; devices are adopted beside it. Remove and re-add an existing CCU.

## [1.2.162] - 2026-10-29

### Changed

- Homematic value changes now log (debug) when accepted and when dropped, with the reason

## [1.2.161] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.160] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.159] - 2026-10-27

### Added

- Homematic Provider: Homematic / HomematicIP (CCU3 / RaspberryMatic) device-provider addon for CamStack — wraps the nodehomematic library.
- Provides the addon Homematic.
