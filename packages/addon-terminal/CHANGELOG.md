# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
