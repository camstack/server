# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The hub exposes the network scan engine, saved scan subnets and discovery-mode classification calls

## [1.2.702] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.701] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.700] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.699] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.698] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.697] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [1.2.696] - 2026-10-29

### Changed

- A node now announces a desktop-app self-update and a container booting on a new image as a node update notification, and node-restarting/node-updating can be picked in notification templates

## [1.2.695] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.694] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.693] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.692] - 2026-10-29

### Changed

- A node inside the desktop app reports the app version and update state to the hub, and the hub can trigger install and restart.

## [1.2.691] - 2026-10-29

### Changed

- An unpaired agent now shows its real memory on its own page instead of unknown.

## [1.2.690] - 2026-10-29

### Changed

- The agent reports its memory, reclaims stranded pages and gets a heap ceiling sized to the host; a node's launch parameters (heap ceiling, allocator) come from the server and can be overridden per node from the hub

## [1.2.689] - 2026-10-29

### Added

- A node's free memory comes from the metrics provider instead of os.freemem(), which undercounts on macOS
- device-export gains optional methods to list, expose and unexpose actions and notification targets beside devices.
- Forget node now works on an online node too: its certificates are revoked, its connection is cut and calls pinned to it fail at once.
- Generated routers for the pet-fountain capability
- Agents report their own process memory in the topology (the core process showed 0), and an unreadable memory shows as unknown

### Changed

- The agent now reports its own [mem] agent-main heartbeat and reclaims stranded memory, as the hub does
- The hub tells its addon runners which telemetry categories anyone consumes, so unused ones stop crossing the process boundary
- Node launch parameters (heap ceiling, allocator env) are decided by a closure module, with a per-node override and a source line in the boot log
- A node's heap-ceiling override can be read and set through server-management (applies at the next restart)

## [1.2.688] - 2026-10-29

### Changed

- Forgetting a node now clears its per-node capability overrides and tells every node-removal-hook owner
- Forgetting an offline node now revokes its mesh certificates, so it can no longer rejoin by itself; a revoked agent learns it was removed and resets to unpaired.

## [1.2.687] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.686] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [1.2.685] - 2026-10-29

### Added

- Generated routers for the new ir-transmitter and remote capabilities
- The remote and template capabilities are routed, and a bound remote command is honoured on cross-node calls

## [1.2.684] - 2026-10-29

### Changed

- A form posted through an addon's data plane (a vendor sign-in page) reaches the addon unchanged instead of re-encoded as JSON

## [1.2.683] - 2026-10-28

### Changed

- Agents found on the network lists each agent's name

## [1.2.682] - 2026-10-28

### Changed

- A freshly paired or re-registered agent node now receives every any-node addon installed on the hub, at the hub version
- A fresh agent is named after its short host name and architecture, and the hub offers agents its internal address instead of the public endpoint

## [1.2.681] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.680] - 2026-10-28

### Fixed

- A desktop or container agent renamed from its own page now shows the new name on the hub right away, even when the rename was made while it was pairing

## [1.2.679] - 2026-10-28

### Changed

- A pet feeder shows whether it runs on mains or on its battery
- Added the ir-transmitter capability routes.

## [1.2.678] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.677] - 2026-10-28

### Changed

- An agent now keeps its own server closure current: unpaired it follows the npm latest, paired it follows the hub's version, checked at boot and every 6 hours (turn off with CAMSTACK_AGENT_SELF_UPDATE=off).

## [1.2.676] - 2026-10-28

### Fixed

- An agent advertises itself on the network again, so the hub lists a new agent for pairing without typing its address
- An unpaired agent no longer crash-loops: it stays up to be paired and starts its addons once pairing completes

## [1.2.675] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.674] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.673] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.672] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.671] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.670] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.669] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.668] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.667] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.666] - 2026-10-28

### Changed

- The hub raises a critical alert when npm or Hugging Face stays unreachable, and resolves it on the next success

## [1.2.665] - 2026-10-28

### Changed

- A shared events link can open a track's detail page, and shared links now use the operator's colour palette
- The hub raises a critical alert when npm cannot be reached (addon and server updates are paused) and resolves it when the registry answers again

## [1.2.664] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.663] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.662] - 2026-10-27

### Added

- The hub serves Actions: list, run, stop, run traces and camera links

## [1.2.661] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.660] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.

## [1.2.658] - 2026-10-27

### Added

- CamStack Server (@camstack/server).
