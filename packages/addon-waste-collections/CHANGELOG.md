# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.37] - 2026-11-07

### Changed

- Waste sources are managed in the Calendars list with a per-row Fetch now; the old source-list actions are removed
- The addon no longer declares an addon-level settings form; fetching all calendars is a Calendars page action
- The Calendars page no longer shows the old settings blurb; Fetch all now moved to the page header

## [0.1.36] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.1.35] - 2026-11-06

### Changed

- A boot after the credentials moved to the keychain no longer crash-loops the integrations runner

## [0.1.34] - 2026-11-06

### Changed

- Waste collection sources are now instances: add, edit, switch, test and delete them through the instances API (country, then service); credentials live in the keychain, and sources kept in the old settings are copied over once at startup
- Waste sources: credentials saved as plain text before the keychain move are re-saved through it, an unconverted source is named in the log and kept served from the old setting until the migration lands, and Test connection asks to configure a source that lacks required arguments
- Waste sources: a credential an older version saved as plain text is moved into the keychain from the record itself, sources not yet migrated are served beside the records while writes keep landing in records, and a redacted credential is never sent to a service
- Waste sources: plain-text credentials are moved into the keychain before the secret kind is declared and retried on the next start if that fails, and deleting a source also removes its row from the old sources setting
- A waste source's on/off switch now goes through the shared instance switch; the stored enabled flag and every reader are unchanged

## [0.1.33] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.1.32] - 2026-10-29

### Changed

- Runs in the shared integrations runner with the other low-traffic integration addons, saving one process of memory (restarting it restarts them together)

## [0.1.31] - 2026-10-27

### Changed

- Shown as "Waste Collection".

## [0.1.30] - 2026-10-27

### Added

- Waste Collection: Waste collection schedules via the vendored HACS waste_collection_schedule Python core — full source catalog as calendar-source.
- Provides the addon Waste Collection.
