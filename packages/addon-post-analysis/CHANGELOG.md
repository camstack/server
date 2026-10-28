# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A Correct/Wrong tap on a notification whose track has already been discarded now still saves a training frame from the recording, into the Notification verdicts collection.

## [1.2.649] - 2026-10-28

### Changed

- The Notification center now appears under System on the Integrations page
- A notification rule passes the delivery parameters its target's notifier declares (such as Echo mode and volume) along with the message.

## [1.2.648] - 2026-10-28

### Changed

- Battery alerts, state summaries and analytics history read device values by their quantity name after the field rename

## [1.2.647] - 2026-10-28

### Changed

- The parked-object appeared/departed event now names the zones the object is in

## [1.2.646] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [1.2.645] - 2026-10-28

### Fixed

- A track read now answers only for the camera it was asked under

## [1.2.644] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.643] - 2026-10-27

### Added

- Post-Analysis: Post-Analysis bundle — enrichment, embedding-encoder, pipeline-analytics. Multi-entry npm package shipping addons that consume pipeline output.
- Provides the addons Embedding Encoder, Pipeline Analytics.
