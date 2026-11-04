# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Tuya accounts are now typed records under their integration; the Access Secret stays in the keychain and the legacy settings rows are moved and cleared on first start

## [0.2.149] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.148] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.147] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.146] - 2026-10-27

### Added

- Tuya Provider: Tuya / Smart Life device-provider addon for CamStack — account-onboarded (Tuya IoT cloud fetch of device localKeys) + LOCAL DP control via the @apocaliss92/nodetuya encrypted-LAN client, exposing switch / water-heater-family kettle entities.
- Provides the addon Tuya.
