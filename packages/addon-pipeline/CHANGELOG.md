# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Adding a non-camera device no longer makes every stream broker log a failed stream-catalog pull.

## [1.2.634] - 2026-10-29

### Changed

- Alexa live-view sessions log the peer's ICE candidates and whether it ever sent a connectivity check, to diagnose sessions that never connect

## [1.2.633] - 2026-10-28

### Changed

- A battery camera waking up for an event no longer reports its stream offline and online again

## [1.2.632] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.631] - 2026-10-27

### Changed

- Motion detection is shown as "Motion Detection" (was "Motion Detection (WASM)").

## [1.2.630] - 2026-10-27

### Added

- Pipeline: Pipeline bundle — runner, detection, motion, audio + stream broker. Multi-entry npm package shipping pipeline addons under a single bundle.
- Provides the addons Pipeline Runner, Detection Pipeline, Motion Detection, Audio Analyzer, Stream Broker, Recorder.
