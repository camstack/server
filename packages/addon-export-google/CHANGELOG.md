# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.119] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [0.1.118] - 2026-10-29

### Changed

- Runs in the shared integrations runner with the other low-traffic integration addons, saving one process of memory (restarting it restarts them together)

## [0.1.117] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.1.116] - 2026-10-27

### Changed

- Shown as "Google Home Export".

## [0.1.115] - 2026-10-27

### Added

- Google Home Export: Google Home Export — hub-side smart-home fulfillment (SYNC / QUERY / EXECUTE / DISCONNECT) for the non-camera fleet, served over the hub's own OAuth account link. No Google credential is stored, sent or required.
- Provides the addon Google Home Export.
