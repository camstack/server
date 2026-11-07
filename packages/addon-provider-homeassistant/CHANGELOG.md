# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Internal: its stored state is now read and written through the typed state API under the same storage key; nothing changes for the operator.

## [1.2.670] - 2026-11-07

### Changed

- The Home Assistant notifier no longer serves a target CRUD of its own

## [1.2.669] - 2026-11-06

### Changed

- Translations that were silently ignored because the catalog nested its keys are now loaded.

## [1.2.668] - 2026-11-06

### Changed

- Notification targets are instances of the notification function: Telegram, Home Assistant, Alexa and the rest keep their ids, switches and secrets, and rules naming them keep dispatching

## [1.2.667] - 2026-11-06

### Changed

- Removed the broker-select field type; every broker link is now an instance-select field on the one link primitive
- Removed the deprecated broker-named in-use helpers; a delete refused for a linked instance is the one InstanceInUseError
- Reads the instance switch through the shared isInstanceEnabled helper; behaviour unchanged
- The media-player status carries positionUpdatedAt (null).

## [1.2.666] - 2026-11-06

### Changed

- Home Assistant notify targets pick their connection through the shared instance picker
- Home Assistant calendars are now their own instances under Connectivity → Calendars; the connection's calendar list is migrated into them

## [1.2.665] - 2026-11-06

### Changed

- Export targets pick their Home Assistant connection through the shared instance picker, and the hub refuses to delete a connection a target still uses

## [1.2.664] - 2026-11-06

### Changed

- Home Assistant connections are served as instances next to the integrations, so the Brokers section reads them from the shared instances list
- Deleting a Home Assistant connection is refused while an integration still uses it, on the instances page
- A Home Assistant integration names its connection by id on its own record; the connection owns nothing of its integration and deleting one still in use is refused with the list of users
- The Home Assistant export ignores a connection that is switched off, as before.
- Home Assistant export keeps its links and enabled targets when the connection list cannot be read while the provider restarts
- A Home Assistant connection link that cannot be read back is left in place and logged; it no longer blocks the integration.

## [1.2.663] - 2026-11-05

### Fixed

- Fix: Home Assistant export migrations apply on hubs that still hold legacy integration rows (they were refused by the migrations door)

## [1.2.662] - 2026-11-05

### Changed

- The integration form is declared as the instance form; brokers and their stored values are unchanged.

## [1.2.661] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [1.2.660] - 2026-11-05

### Changed

- Home Assistant: the calendars an instance imports are now a field of the instance itself (edited in its form), moved there automatically from the old integration settings

## [1.2.659] - 2026-11-04

### Changed

- Home Assistant export targets are now integration instances: add several, each pointing at a Home Assistant connection with its own image-link address; existing exports carry over unchanged.

## [1.2.658] - 2026-11-04

### Changed

- Fixed the Home Assistant export migration reading every switch as off after the instances moved to typed records; it now reads the legacy integration row and refuses when that row is unreadable.
- Image links sent to Home Assistant now prefer the public endpoint (falling back to the internal address when none is set), so notifications show images away from home.

## [1.2.657] - 2026-11-04

### Changed

- Home Assistant broker migrations no longer read as 'skipped-newer' (and no false 'Database is newer' alert) after the addon boots

## [1.2.656] - 2026-11-04

### Changed

- Home Assistant export: each instance's export switch, image-link address and exported devices now live in one record per instance; a migration moves the old settings and integration values, and the export no longer reads them

## [1.2.655] - 2026-11-04

### Changed

- Exposing or hiding a device in Home Assistant export changes only the Home Assistant instance it names, not every instance
- Home Assistant connections are listed on the instances page; their stored connection is flattened once at start-up (same ids and tokens).
- Connections move to the flat body without stranding keychain refs: the old token refs are released when the nested object goes

## [1.2.654] - 2026-11-03

### Changed

- A Home Assistant media player supports turn on/off and stepped volume and channel, and declares them as features
- Each Home Assistant instance now keeps its own calendars to import, its export switch and its image address role on its integration; the old shared settings are copied over on first start.

## [1.2.653] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [1.2.652] - 2026-11-02

### Changed

- Home Assistant can hand an ESPHome board's encryption key from its ESPHome Builder add-on to CamStack, over the existing access token (administrator only).
- pump-cycle is classified as not exported to Home Assistant

## [1.2.651] - 2026-11-02

### Changed

- A Home Assistant restart no longer parks the link for 10 minutes: a 404 must persist for a minute before the component counts as missing, and a suspended link is now logged and reported on every reconcile

## [1.2.650] - 2026-11-02

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
