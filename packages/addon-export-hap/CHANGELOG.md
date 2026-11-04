# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.191] - 2026-11-04

### Changed

- Export calls name the export instance they address; an unknown instance is refused with export-instance-unknown
- HomeKit export keeps its bridge identity (name, MAC, setup code, pairing folder) in a default instance, adopted unchanged from the old settings so paired controllers keep working
- HomeKit export keeps the devices and actions a bridge exposes in the bridge's own record, moved unchanged from the old settings

## [1.2.190] - 2026-11-03

### Changed

- The network interface is a per-node setting, and the fixed setup code is a password field kept in the keychain

## [1.2.189] - 2026-11-01

### Changed

- A heater is exported to HomeKit as a switch.

## [1.2.188] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.187] - 2026-10-31

### Changed

- A lock reporting door-open shows as unsecured in HomeKit.

## [1.2.186] - 2026-10-29

### Changed

- HomeKit export can now expose an Action as a momentary switch that runs it and turns itself off after a second.

## [1.2.185] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.184] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.183] - 2026-10-27

### Added

- HomeKit Export: HomeKit (HAP) exporter for CamStack devices. Publishes each exposed device as its own HomeKit accessory: cameras and doorbells with SRTP streaming, HomeKit Secure Video, motion, two-way audio, PTZ and battery; switches, lights, locks and sensors through a capability→service table.
- Provides the addon HomeKit Export.
