# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Commands no longer wait behind a device poll and the device state refreshes right after each command; humidifiers (Classic, Dual, LV600S/OasisMist, 1000S, Superior 6000S) are adopted with target humidity, mode, display and humidity / water-tank sensors; moving the purifier speed slider in Auto or Sleep switches it to Manual

## [0.2.164] - 2026-11-17

### Changed

- Purifiers declare their VeSync device id and MAC as identifiers, so the same purifier from another integration can be matched.

## [0.2.163] - 2026-11-17

### Changed

- The VeSync Country code is a list to pick from.
- VeSync sign-in works again (official app ID); restarts no longer trigger new-login emails.

## [0.2.162] - 2026-11-17

### Changed

- VeSync keeps its session across restarts instead of signing in each time.

## [0.2.161] - 2026-11-17

### Changed

- VeSync: new optional Country code on the account (ISO two letters, e.g. IT) so a non-US account can sign in; an 'auth code expired' refusal now says to set it

## [0.2.160] - 2026-11-17

### Changed

- VeSync accounts now sign in through the tsvesync client (they could not log in before), and the integration form has a connection test that names a refused password, a region neither VeSync endpoint accepts, or an unreachable cloud
- Requires tsvesync 1.4.9, the version its sign-in failure classification is built on.
- The VeSync addon shows the original VeSync brand icon

## [0.2.159] - 2026-11-14

### Changed

- A stored hub device is no longer converted into an integration on restore. A backup from before that conversion is left as-is.
- The retired hub-to-integration migration is declared, so databases that already ran it no longer raise a newer-database alert

## [0.2.158] - 2026-11-12

### Changed

- A fresh install no longer refuses to start: a migration that waits for the device-restore phase is deferred instead of blocking the addon

## [0.2.157] - 2026-11-12

### Changed

- A new VeSync gateway is named "VeSync".

## [0.2.156] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.2.155] - 2026-11-08

### Changed

- Settings migration creates the instance through the single create door

## [0.2.154] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.153] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.152] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.2.151] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.150] - 2026-11-05

### Changed

- VeSync accounts are integration instances: credentials live on the account record, purifiers keep their ids, and the old hub device becomes a Gateway sibling

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

- VeSync Provider: VeSync cloud-account device-provider addon for CamStack — Levoit / Cosori air purifiers as Fan devices (power, speed, preset, child-lock, display, air-quality + filter-life sensors).
- Provides the addon VeSync.
