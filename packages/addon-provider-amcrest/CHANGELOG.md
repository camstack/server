# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
