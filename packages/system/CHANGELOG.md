# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A pet feeder shows whether it runs on mains or on its battery
- Added the ir-transmitter capability and its error texts.

## [1.2.509] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.508] - 2026-10-28

### Changed

- The hub's registration ack now carries the hub's server version so agents can align to it.

## [1.2.507] - 2026-10-28

### Fixed

- An agent advertises itself on the network again, so the hub lists a new agent for pairing without typing its address

## [1.2.506] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.505] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.504] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.503] - 2026-10-28

### Changed

- A Hugging Face outage seen by model downloads now raises a critical alert on the hub and resolves it on the next successful download

## [1.2.502] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.501] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.500] - 2026-10-27

### Fixed

- Creating, editing and running an Action no longer fails with an internal error

## [1.2.499] - 2026-10-27

### Added

- Core blocks serve Actions: camera-linked permissions, run traces and automation cooldown now live in the hub runs ledger

### Fixed

- Creating, editing and running an Action no longer fails with an internal error

## [1.2.498] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.497] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.

## [1.2.496] - 2026-10-27

### Added

- CamStack System: Core addon for CamStack — builtins, pipeline, process management, auth, logging, events.
- Provides the addons Filesystem Storage, SQLite Settings, Winston Logging, Console Logging, Loki Logging, Hub Log Forwarder, Backup Orchestrator, Storage Orchestrator, Keychain, Record Entries, Native Metrics, Device History, Snapshot, PTZ Autotrack (emulated), Alert Center, Liveness Monitor, System Config, Calendars, Addon Pages Aggregator, Addon Widgets Aggregator, Device Manager, Local Auth, Platform Probe (Native), Local Network, Remote Access Orchestrator, Core Blocks, Composer, Camera Grids.
