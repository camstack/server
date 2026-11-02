# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A finished-cycle notification whose custom template drops the run summary is now logged once per rule; the cycle default text is served to editors
- A parcel the model sees inside a scene-difference zone now opens a candidate, a lower-confidence continuing box keeps it alive, and a day-to-IR switch no longer blinds the scene check
- A courier who never became a tracked person no longer blocks a parcel delivery: person-sized motion beside the drop-off zone backs the candidate

## [1.2.664] - 2026-11-02

### Changed

- A package notification's still is now taken from a live camera frame when the look frame's handle has expired, so parcel notifications on cameras like 615 carry their picture again.

## [1.2.663] - 2026-11-02

### Changed

- A sensor or alarm notification now wakes a sleeping battery camera once, waits up to 15 s for its still, and a rule can opt out

## [1.2.662] - 2026-11-01

### Changed

- An appliance that finishes its cycle now notifies by default as "<Device> ha terminato dopo N minuti", and the text can carry the energy used
- The appliance finish notification reads the recorded run, so duration and energy survive a restart.

## [1.2.661] - 2026-11-01

### Changed

- A capture request now expires exactly at its deadline instead of one millisecond after, so an abandoned confirmation crop no longer holds the head of the lane and sheds key frames.
- Notification templates: {{camera}} is now {{device}}. Your saved rules, timelapse captions and text overrides are rewritten once at the first start; {{camera}} keeps rendering in a template an older app still writes

## [1.2.660] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.659] - 2026-11-01

### Changed

- Notification rules fire once per appliance start/finish (running-state flip), not on every status refresh

## [1.2.658] - 2026-11-01

### Changed

- A still object whose notification was delivered is no longer discarded while its Correct/Wrong buttons are valid, so the verdict tap finds its track.

## [1.2.657] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.656] - 2026-10-31

### Changed

- A lock reporting door-open counts as an opening for the alarm.

## [1.2.655] - 2026-10-31

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
