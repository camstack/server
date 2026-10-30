# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
