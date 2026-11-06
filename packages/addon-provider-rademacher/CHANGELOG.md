# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.161] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.2.160] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.159] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.158] - 2026-11-04

### Changed

- Rademacher hub connections are now typed integration instances; existing hubs are migrated on the first start, nothing to re-enter

## [0.2.157] - 2026-11-02

### Changed

- Rademacher covers declare cover-stoppable so their stop control stays exported.

## [0.2.156] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.2.155] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [0.2.154] - 2026-10-31

### Changed

- The adoption modal lists the HomePilot gateway beside its roller shutters instead of nesting them under it.

## [0.2.153] - 2026-10-31

### Changed

- Rademacher no longer appears in the network scan: a hub is added by typing its host, because nothing a hub answers tells it apart from other web servers

## [0.2.152] - 2026-10-31

### Changed

- Shows the Rademacher logo as the integration icon.

## [0.2.151] - 2026-10-31

### Changed

- Shutters are offered for adoption nested under the hub.

## [0.2.150] - 2026-10-30

### Changed

- The HomePilot hub is found by the shared network scan, including on other subnets

## [0.2.149] - 2026-10-30

### Changed

- Rademacher is now an integration: add it from Integrations (the hub on your network is offered automatically), test the login, and adopt the Gateway (web link, firmware) and the covers. The old standalone Rademacher hub device is removed; add the hub again.

## [0.2.148] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.147] - 2026-10-27

### Added

- Rademacher Provider: Rademacher HomePilot device-provider addon for CamStack — wraps the @apocaliss92/noderademacher local-hub client (roller shutters over the cover cap).
- Provides the addon Rademacher.
