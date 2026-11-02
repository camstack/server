# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Home Assistant export: a cover offers position and tilt only when the device declares them, shows unavailable while its provider is offline, and a refused command now answers 422 with the reason
- A cover exports the stop control to Home Assistant only when the device declares cover-stoppable, and a Home Assistant cover with the STOP bit declares it.

## [1.2.649] - 2026-11-02

### Changed

- The retired media base URL setting is now removed from the settings table where it is actually stored

## [1.2.648] - 2026-11-02

### Changed

- Home Assistant export: the Hub URL setting is gone; each Home Assistant instance now chooses whether its image links use the Internal address or the Public endpoint of the Network page.

## [1.2.647] - 2026-11-02

### Changed

- The new do-not-disturb capability is recorded as not exported to Home Assistant

## [1.2.646] - 2026-11-01

### Changed

- The timed-run capability is listed as not exported to Home Assistant.

## [1.2.645] - 2026-11-01

### Changed

- Classified the device-runs capability as not exported.

## [1.2.644] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.643] - 2026-10-31

### Changed

- The power-source capability is not exported to Home Assistant (manual admin recovery action).

## [1.2.642] - 2026-10-31

### Changed

- A lock reporting door-open is published to Home Assistant as open.

## [1.2.641] - 2026-10-31

### Changed

- A test notification's sample image now reaches Home Assistant as an absolute public URL

## [1.2.640] - 2026-10-30

### Changed

- Home Assistant export: a failed push now states the reason in the log (missing CamStack component, rejected token, unreachable, too large), a missing component is no longer retried every tick, the integration status shows the last failure, and an oversized batch is split instead of dropped.
- Notification targets pick a broker and list their options inside the add/edit form; the page-wide Find devices dialog is gone

## [1.2.639] - 2026-10-29

### Changed

- Home Assistant state changes reach CamStack once each, not once per listener.

## [1.2.638] - 2026-10-29

### Changed

- Runs in the shared integrations runner with the other low-traffic integration addons

## [1.2.637] - 2026-10-29

### Added

- Actions and notification targets can be exported to Home Assistant: an action becomes a button, a target becomes a notify entity (needs a component that builds notify).

### Changed

- The pet fountain capability is listed as not exported to Home Assistant
- The exported node memory sensor stays unknown when the node's memory could not be read
- The Home Assistant export runs in the shared integrations runner with the other low-traffic integration addons, saving one process of memory

## [1.2.636] - 2026-10-29

### Changed

- Media players report their state as reported

## [1.2.635] - 2026-10-28

### Changed

- Recorded that the ir-transmitter capability is not exported to Home Assistant.

## [1.2.634] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.633] - 2026-10-27

### Changed

- Shown as "Home Assistant" (was "Home Assistant Provider").

## [1.2.632] - 2026-10-27

### Added

- Home Assistant: Home Assistant device provider addon for CamStack.
- Provides the addons Home Assistant, Home Assistant Export.
