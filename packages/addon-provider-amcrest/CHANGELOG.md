# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.170] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.169] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.168] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.2.167] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.166] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.165] - 2026-11-04

### Changed

- The amcrest integration is now a typed integration instance and its devices are claimed to it

## [0.2.164] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.163] - 2026-10-30

### Changed

- The Amcrest icon is no longer distorted
- Cameras are found by the shared network scan (WS-Discovery and a CGI probe confirmed with the scan credentials); the scan-options subnet field is gone

## [0.2.162] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.161] - 2026-10-27

### Added

- Amcrest Provider: Amcrest/Dahua camera device provider addon for CamStack — Dahua CGI over HTTP(S) with digest auth (snapshot, RTSP catalog, PTZ, image/day-night config).
- Provides the addon Amcrest.
