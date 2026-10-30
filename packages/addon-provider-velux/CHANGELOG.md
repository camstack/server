# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A Velux gateway is now found by the shared network scan, including on other subnets

## [0.2.150] - 2026-10-30

### Changed

- Fix the Velux addon failing to talk to the gateway when deployed: the bundled output now carries every KLF-200 frame decoder instead of looking for files beside it
- Velux is now an integration: add it from Integrations (the KLF-200 on your network is offered automatically), test the login, and adopt the Gateway (reboot, firmware, web link), windows with a rain sensor, and covers. The old standalone Velux device is removed; add the gateway again.

## [0.2.149] - 2026-10-29

### Changed

- Velux KLF-200 now connects for real: windows, shutters, blinds and awnings are covers whose state is pushed by the gateway, a roof window's rain sensor is a leak sensor, and a dropped session reconnects by itself (see the addon README for the gateway's two-connection limit)

## [0.2.148] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.147] - 2026-10-27

### Added

- Velux Provider: Velux KLF-200 device-provider addon for CamStack — local-gateway window + shutter covers (positional, no tilt).
- Provides the addon Velux.
