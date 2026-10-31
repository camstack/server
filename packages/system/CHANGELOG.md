# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Actions resolve a device-domain target when a step runs, and stored actions are rewritten to the target shape once at start

## [1.2.529] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.528] - 2026-10-31

### Changed

- The addon convergence dry-run switch is readable on a hub with an isolated settings engine.

## [1.2.527] - 2026-10-31

### Changed

- Cluster node history keeps per-node package tombstones so a removed addon stays off that node

## [1.2.526] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.525] - 2026-10-30

### Added

- One network scan for all providers: the local-network engine runs every provider's discovery once, and extra subnets can be saved to scan other VLANs

### Changed

- Network scan resends the multicast query three times over about 4.5 s and logs hits per subnet, so Wi-Fi boards that miss one query are found
- Hub: a stale-data audit finds record kinds and settings keys an addon no longer declares, read-only, with an operator-triggered cleanup

## [1.2.524] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.523] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.522] - 2026-10-29

### Changed

- The remote template editor's component palette is served by core-blocks through the new remote-layout-components capability

## [1.2.521] - 2026-10-29

### Changed

- Saving an internal Action converts a quantity argument entered in another unit (0.1 kg for a feed in grams) and reports a bare number as a warning

## [1.2.520] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.519] - 2026-10-29

### Changed

- Memory reclaim judges anonymous resident memory on Linux, and telemetry nobody listens to (including broker messages) no longer reaches a child process

## [1.2.518] - 2026-10-29

### Added

- macOS nodes report memory the way Activity Monitor does (app + wired + compressed) instead of total minus free pages
- A built composed device serves its methods by forwarding them to a source device, and a consumable item can reset through a forwarded button
- The pet-fountain capability reaches the kernel through the generated types
- Linux memory comes from MemAvailable; a failed memory read is reported as unknown instead of a made-up percentage

### Changed

- Memory reclaim now judges the stranded memory by anonymous resident pages on Linux, so file-backed SQLite mappings no longer trigger useless reclaim passes
- Heap-watch exports the agent-main label used by the agent root heartbeat
- A forked addon runner no longer sends high-frequency telemetry (pipeline traces, metrics snapshots) to the hub when nothing there listens, cutting event traffic
- The hub and agent boot line says who chose the heap ceiling (override, legacy env, computed or V8 default)
- The broker state mirror (broker.message) is no longer kept in the recent-events ring, so it stops evicting other events; live subscribers are unaffected

## [1.2.517] - 2026-10-29

### Added

- The Actions list answers at once when no addon provides actions, instead of waiting about 30 seconds.

### Changed

- deviceManager.updateConfig now refuses a key the device config does not own instead of answering success without writing
- Forgetting a cluster node records a durable tombstone so node-scoped data is cleaned up even if an owner was down
- A revoked mesh peer is refused and logged once per window, and the hub answers a signed membership query so a forgotten agent can reset itself.

## [1.2.516] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.515] - 2026-10-29

### Changed

- SmartIR code import, remote command engine and an assumed-state media player for infrared appliances
- Remote and templates are served by core-blocks; a device-call redirect gives a bound remote command precedence over the native media-player cap for every caller

## [1.2.514] - 2026-10-28

### Changed

- An agent tells its display name in its mDNS record and pairing hello

## [1.2.513] - 2026-10-28

### Changed

- The agent pairing status tells the local view whether a pairing lockout is in force

## [1.2.512] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.511] - 2026-10-28

### Fixed

- Pairing: the agent reveals its own code only after local confirmation; the confirm answer carries it

## [1.2.510] - 2026-10-28

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
