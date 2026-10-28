# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.432] - 2026-10-28

### Changed

- The vendor login proxy is served on one shared vendor-login prefix that cannot shadow an addon's own routes
- Unknown event kinds and state words now read as a humanized label ("Delivery truck") instead of the raw id

## [1.2.431] - 2026-10-27

### Changed

- Addons can now offer a vendor sign-in that opens the vendor's login page through the hub and finishes on the CamStack result page.

## [1.2.430] - 2026-10-27

### Added

- Actions: declared list entries (action-source, actions caps), an action step for automations, and run traces kept in the hub ledger
- Automations gain detection and interval triggers, per-automation run modes (single, restart, queued, parallel, cooldown), condition reads from an in-memory mirror, and a ring of run traces

## [1.2.429] - 2026-10-27

### Added

- pet-feeder reports bowlFood, eating and supportsMarkRefilled

## [1.2.428] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.
- Cloud integrations raise one alert when their session is lost and clear it when it is back

## [1.2.427] - 2026-10-27

### Added

- CamStack Types: Shared types, interfaces, and model catalogs for the CamStack detection ecosystem.
