# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Runs in the shared integrations runner with the other low-traffic integration addons, saving one process of memory (restarting it restarts them together)

## [0.1.31] - 2026-10-27

### Changed

- Shown as "Waste Collection".

## [0.1.30] - 2026-10-27

### Added

- Waste Collection: Waste collection schedules via the vendored HACS waste_collection_schedule Python core — full source catalog as calendar-source.
- Provides the addon Waste Collection.
