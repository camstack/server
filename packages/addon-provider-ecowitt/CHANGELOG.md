# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.176] - 2026-11-26

### Changed

- Rebuilt against updated dependencies.

## [0.2.175] - 2026-11-24

### Changed

- The Ecowitt weather station now offers an Illuminance (lux) sensor derived from its solar radiation reading (about 126.7 lux per W/m2), usable for day/night thresholds.

## [0.2.174] - 2026-11-21

### Changed

- Rebuilt against updated dependencies.

## [0.2.173] - 2026-11-19

### Changed

- Ecowitt gateways are read by the core's scheduled state refresh (your poll interval still slows it) instead of a library timer; needs @apocaliss92/nodewitt 1.5.0.
- A changed poll interval now re-schedules the gateway refresh, and an unknown connection refreshes every 60 s instead of every second

## [0.2.172] - 2026-11-18

### Changed

- Add device inside an integration lists only its own devices, with no network scan

## [0.2.171] - 2026-11-18

### Changed

- The Gateway device declares the gateway's MAC and address as its identifiers; the MAC comes from the network scan or is read from the gateway when its client starts, and a MAC read at another host is dropped, never kept beside the new address

## [0.2.170] - 2026-11-17

### Changed

- A battery on this device reports charge only; it no longer pretends to answer a camera wake
- Re-sync is now offered through the device's own resync capability

## [0.2.169] - 2026-11-17

### Changed

- The integration has a Test button: it reads the gateway once and says whether the password was refused, the gateway wants one, the address is not an Ecowitt gateway, or it did not answer.

## [0.2.168] - 2026-11-15

### Fixed

- The duplicate and station-reading sensor devices are now actually retired: the scan no longer skips station containers, which carry no system field

## [0.2.167] - 2026-11-15

### Changed

- The weather station now supplies every outdoor reading itself, with history; the standalone outdoor sensor devices are retired and their history is dropped
- The weather station also shows the gateway barometer when its own array has none

## [0.2.166] - 2026-11-14

### Changed

- The outdoor Ecowitt array becomes a weather station, keeping its device id, and publishes that reading from the same gateway poll.

## [0.2.165] - 2026-11-14

### Changed

- A stored hub device is no longer converted into an integration on restore. A backup from before that conversion is left as-is.
- The retired hub-to-integration migration is declared, so databases that already ran it no longer raise a newer-database alert

## [0.2.164] - 2026-11-12

### Changed

- A new Ecowitt gateway is named "Ecowitt" plus the model the station announced.

## [0.2.163] - 2026-11-11

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
