# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Cameras are found by the shared network scan (WS-Discovery and an ISAPI probe confirmed with the scan credentials); the scan-options subnet field is gone

## [1.2.178] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.177] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.176] - 2026-10-27

### Added

- Hikvision Provider: Hikvision camera device provider addon for CamStack — ISAPI over HTTP(S) with digest auth (snapshot, alarm stream, RTSP discovery).
- Provides the addon Hikvision.
