# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Corrected a code comment that still described the retired Hub gateway device

## [0.2.162] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.2.161] - 2026-11-08

### Changed

- Settings migration creates the instance through the single create door

## [0.2.160] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.159] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.158] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.2.157] - 2026-11-05

### Changed

- Internal: the connection form comment names the instance form; no behaviour change.

## [0.2.156] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.155] - 2026-11-04

### Changed

- Ecowitt gateways keep their connection (transport, host, port, password, poll and listen settings) as one typed record each, moved from the old settings by a boot migration; devices, ids and history are untouched

## [0.2.154] - 2026-11-01

### Changed

- Ecowitt: weather-station and CH1 sensors are no longer duplicated under the gateway container; existing duplicates are removed on the next reading

## [0.2.153] - 2026-11-01

### Changed

- Built against the server that now carries the framework itself; requires a matching @camstack/server.
- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.152] - 2026-11-01

### Changed

- Ecowitt is now an integration with a Gateway device, like the other account integrations; the old Hub device is migrated automatically and every container and sensor keeps its id and history
- Ecowitt hub migration no longer stops at one bad hub, resumes cleanly after an interrupted run, and a failed or locked settings read can no longer remove an integration's devices

## [0.2.151] - 2026-10-30

### Changed

- Ecowitt gateways are found by the shared network scan (one UDP broadcast for every subnet); the per-scan broadcast address form is gone

## [0.2.150] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.149] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.148] - 2026-10-27

### Added

- Ecowitt Provider: Ecowitt weather-station device-provider addon for CamStack — wraps the @apocaliss92/nodewitt local-poll / push client.
- Provides the addon Ecowitt.
