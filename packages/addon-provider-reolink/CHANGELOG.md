# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.219] - 2026-11-02

### Changed

- Battery cameras now mail motion to the camera mailbox of the Email (SMTP) addon instead of a server inside Reolink; your cameras keep their port, address and credentials, and the mailbox appears under Brokers; Reolink starts and runs its cameras even when the Email (SMTP) addon is not installed, and creates the mailbox with your old credentials as soon as it is available
- Battery-camera motion push (HaCfg webhook) is now received on the addon's own HTTP endpoint at the hub's internal address (System → Network) instead of a separate port 9081; cameras already using it are re-pointed automatically the next time they connect, and the old webhook settings are removed

## [1.2.218] - 2026-11-02

### Changed

- New debug channel debug.reolink-events: event subscription state per camera, readable from Logs > Watch.

## [1.2.217] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.216] - 2026-10-31

### Changed

- The NVR / Home Hub can be added as a Gateway device (reboot, web interface link) next to its channel cameras.

## [1.2.215] - 2026-10-31

### Changed

- A Reolink NVR / Home Hub is now its own integration: add it from Integrations (its password is kept in the keychain), its channels are adopted as cameras, and an existing Hub device is migrated automatically on first start with its cameras and their settings kept.
- An integration instance can have its own settings form: a Reolink NVR / Home Hub shows its connection only, the default integration keeps the full form

## [1.2.214] - 2026-10-30

### Changed

- Discovery scans every subnet the network scan covers; the network CIDR field in the scan options is gone

## [1.2.213] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.212] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.211] - 2026-10-27

### Added

- Reolink Provider: Reolink camera device provider addon for CamStack — native Baichuan protocol.
- Provides the addon Reolink.
