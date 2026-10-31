# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.151] - 2026-10-31

### Changed

- Shutters are offered for adoption nested under the hub.
- Shows the Rademacher logo as the integration icon.

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
