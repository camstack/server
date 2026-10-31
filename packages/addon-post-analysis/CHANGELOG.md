# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A verdict tapped after the track is gone keeps the notified subject on the stored still; new "Wrong label, class OK" button on detection notifications
- Notification sequences accept a device-domain target and are rewritten to the target shape once at start
- Sun times moved to the shared time module (no behaviour change)

## [1.2.654] - 2026-10-30

### Changed

- A camera you switched off is no longer listed as offline in the state summary and no longer sends an offline notification
- A package-delivered notification now carries a picture of the parcel and its gif, even when the parcel was spotted without a track and the AI confirm took several seconds

## [1.2.653] - 2026-10-30

### Changed

- A node that announced an update is no longer reported offline for 10 minutes; if it comes back nothing is sent, otherwise the offline says it went down while updating

## [1.2.652] - 2026-10-29

### Changed

- Node update notifications for the desktop app and the container image keep their own slot, so they never swallow a server update on the same node

## [1.2.651] - 2026-10-29

### Changed

- The live detection overlay no longer shows boxes from replayed pre-roll frames

## [1.2.650] - 2026-10-28

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
