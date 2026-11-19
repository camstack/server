# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.168] - 2026-11-19

### Changed

- An instance's on/off switch is read from the hub registry row, and moved there from the record on first boot

## [0.1.167] - 2026-11-17

### Changed

- A Terminal's camera is now a Terminal camera block in Build-your-self; existing Terminal cameras are removed on upgrade and must be recreated there.

## [0.1.166] - 2026-11-16

### Changed

- The session list says who opened each shell and when it last saw input or output.

## [0.1.165] - 2026-11-15

### Added

- Admins can open a login shell on a node that opts in; it is off by default, audited, and closed when idle.

### Changed

- Turning a node's server shell off closes its live shells, and a later read or keystroke is refused.

### Fixed

- Pty output after a resize still counts as activity, so a busy server shell is not closed at the idle limit. The idle audit names the user who opened the shell.

## [0.1.164] - 2026-11-11

### Changed

- New one-off adoptLegacyCameras action turns every legacy automatic Terminal camera into an instance, keeping its stable id; a rerun adopts nothing

## [0.1.163] - 2026-11-08

### Changed

- Terminal integration is seeded through the single instance create door

## [0.1.162] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [0.1.161] - 2026-11-07

### Changed

- Terminals are now instances on the Terminal page: the list is kept as records, migrated in place with the same ids and cameras

## [0.1.160] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.1.159] - 2026-11-05

### Changed

- Terminal settings are declared on the per-node settings hook; the form and stored values are unchanged.

## [0.1.158] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.1.157] - 2026-10-31

### Changed

- Deleting a terminal whose node left the cluster now completes instead of hanging

## [0.1.156] - 2026-10-30

### Changed

- A Terminal instance whose node left the cluster is no longer deleted on boot: it is kept, flagged "node not in cluster" with an alert, and can be re-pointed to another node; the boot hang that blocked every instance edit is fixed.

## [0.1.155] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.1.154] - 2026-10-27

### Added

- Terminal: Interactive terminal sessions (pty + xterm) as a CamStack addon.
- Provides the addon Terminal.
