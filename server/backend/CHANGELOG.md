# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
