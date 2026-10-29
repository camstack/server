# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Velux KLF-200 now connects for real: windows, shutters, blinds and awnings are covers whose state is pushed by the gateway, a roof window's rain sensor is a leak sensor, and a dropped session reconnects by itself (see the addon README for the gateway's two-connection limit)

## [0.2.148] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.147] - 2026-10-27

### Added

- Velux Provider: Velux KLF-200 device-provider addon for CamStack — local-gateway window + shutter covers (positional, no tilt).
- Provides the addon Velux.
