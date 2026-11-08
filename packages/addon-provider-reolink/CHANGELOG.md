# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Settings migration creates the instance through the single create door

## [1.2.234] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [1.2.233] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.232] - 2026-11-06

### Changed

- Translations that were silently ignored because the catalog nested its keys are now loaded.

## [1.2.231] - 2026-11-06

### Changed

- A Reolink integration whose cameras mail the camera mailbox now links to it, so deleting the mailbox while it is in use is refused and the link shows in the instance model
- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [1.2.230] - 2026-11-06

### Changed

- The email-push mailbox is created and read through the SMTP addon's instances

## [1.2.229] - 2026-11-05

### Changed

- A Reolink Home Hub / NVR integration no longer offers the manual Enter parameters add in Add device

## [1.2.228] - 2026-11-05

### Fixed

- A deleted camera stops its timers at once instead of polling until the worker restarts

## [1.2.227] - 2026-11-05

### Changed

- Reolink clip catalog refresh default is declared on the fleet-default hook; the form and stored value are unchanged.
- A camera adopted under an NVR / Home Hub now shows its hub and channel in settings, no longer lets you edit its address or credentials (they belong to the integration), and hides the hub-wide ports and time sections.

## [1.2.226] - 2026-11-05

### Changed

- Cameras whose host reports an unknown time zone (Etc/Unknown) no longer fail the clip catalog refresh; it falls back to the camera's offset or UTC.

## [1.2.225] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [1.2.224] - 2026-11-04

### Changed

- Reolink starts again after the update: its integration migrations are offered in order, so the move of the connection settings runs

## [1.2.223] - 2026-11-04

### Changed

- Reolink integrations keep their connection (host, ports, username, transport, password) as one typed record each, moved from the old settings by a boot migration; each integration keeps its own values and password

## [1.2.222] - 2026-11-04

### Changed

- Cameras that named no integration are claimed to the default Reolink integration

## [1.2.221] - 2026-11-03

### Changed

- Compile against the switch status where a never-reported state reads as unknown

## [1.2.220] - 2026-11-02

### Changed

- Battery-camera motion push (HaCfg webhook) is now received on the addon's own HTTP endpoint at the hub's internal address (System → Network) instead of a separate port 9081; cameras already using it are re-pointed automatically the next time they connect, and the old webhook settings are removed

## [1.2.219] - 2026-11-02

### Changed

- Battery cameras now mail motion to the camera mailbox of the Email (SMTP) addon instead of a server inside Reolink; your cameras keep their port, address and credentials, and the mailbox appears under Brokers; Reolink starts and runs its cameras even when the Email (SMTP) addon is not installed, and creates the mailbox with your old credentials as soon as it is available

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
