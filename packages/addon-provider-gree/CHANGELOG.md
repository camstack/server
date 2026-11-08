# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.156] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.155] - 2026-11-06

### Changed

- Translations that were silently ignored because the catalog nested its keys are now loaded.

## [0.2.154] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.2.153] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.152] - 2026-11-05

### Changed

- Gree integrations can list extra /24 subnets to sweep for air conditioners, beyond the hub's own networks.

## [0.2.151] - 2026-11-05

### Changed

- Gree ACs on another VLAN are now found by a unicast sweep, followed by MAC when their IP changes, and the AC's IP/broadcast address is editable in its device settings

## [0.2.150] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.149] - 2026-11-04

### Changed

- Gree integrations are now typed records, and air conditioners added before integrations were named are claimed to the default integration without losing their ids

## [0.2.148] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.147] - 2026-10-31

### Changed

- Gree AC that was unreachable at startup now keeps retrying to bind (5 s, 30 s, then every 3 min) and re-binds after the AC stops answering, instead of staying offline until the addon restarts.

## [0.2.146] - 2026-10-30

### Changed

- Gree ACs are searched on every subnet the network scan covers; the per-scan broadcast address form is gone

## [0.2.145] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.144] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.143] - 2026-10-27

### Added

- Gree Provider: Gree air-conditioner device-provider addon for CamStack — wraps the @apocaliss92/nodegree local-UDP client (LAN discovery + AES control), exposing climate-control and fan-control.
- Provides the addon Gree.
