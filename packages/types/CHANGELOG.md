# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.444] - 2026-10-29

### Added

- Device exporters can declare that they also expose actions and notification targets (device-export entity methods).
- A composed device of a new type can now be commanded: each method of its capability forwards to one method of a source device
- A pet fountain device type with a pet-fountain capability (water level, drinking totals, pump controls)
- A preset to build a pet fountain device from loose entities, with forwarded pump commands and a resettable filter

### Changed

- Node memory is nullable on the metrics and topology contracts: a failed read is unknown, not 0 or 100
- server-management gains getLaunchOverrides / setLaunchOverrides, the per-node heap-ceiling override

## [1.2.443] - 2026-10-29

### Added

- The vendor login proxy writes a names-only trace line per proxied sign-in request (parameter, form-field and cookie names, never values) to show where a sign-in loses a parameter
- Added the no_authorization_code reason to the OAuth result page codes
- Comments on the placement flags now say a role defaults on for every node

### Changed

- A node-removal-hook capability: addons are told when the operator forgets a cluster node

## [1.2.442] - 2026-10-29

### Changed

- A transcode of a local restream starts its first frame sooner (bounded input probe)

## [1.2.441] - 2026-10-29

### Added

- Streams re-encoded for Alexa, HomeKit and other live viewers start sooner because ffmpeg no longer probes the local restream for seconds first
- New ir-transmitter and remote capabilities for infrared control, and media-player status now says whether its state is reported or assumed
- Remote: a generic template collection, a remote Customize extension for media players, and media-player commands that run a bound IR/Actions binding first

### Changed

- Pet feeder: the status carries the last manual-feed portion so a client can start from it

## [1.2.440] - 2026-10-28

### Changed

- Agents advertise their display name over mDNS so a hub can show which machine is which

## [1.2.439] - 2026-10-28

### Changed

- An alert action can now run an addon's custom action as well as link to a page

## [1.2.438] - 2026-10-28

### Changed

- A pet feeder shows whether it runs on mains or on its battery
- Pure IR/RF codecs: pulse-train and transmit-settings schemas, Pronto decoding and SmartIR media_player import.
- Added the ir-transmitter capability: send an infrared or RF pulse train with per-call settings.

## [1.2.437] - 2026-10-28

### Changed

- The vendor sign-in proxy keeps the vendor's session cookie when the vendor also deletes a same-named cookie on another domain
- An AI profile can turn the model's thinking off or set its effort

## [1.2.436] - 2026-10-28

### Changed

- Addon manifest entries can declare which Integrations block they belong to (integrationSection)
- A notifier can declare extra delivery parameters (type, options, default) and a rule target can carry them to it.
- Vendor sign-in proxy: form fields carrying a proxied address are sent back to the vendor with the vendor's own address
- A temperature or humidity group can include thermostats and climate devices, read from their current temperature/humidity

## [1.2.435] - 2026-10-28

### Changed

- Device value fields are named after their quantity (power, level, speed, signal...) instead of their unit; run the quantity-field migration after updating

## [1.2.434] - 2026-10-28

### Added

- Automations can start on a parked object appearing or leaving, filtered by camera, class and zone, and check whether one is present

## [1.2.433] - 2026-10-28

### Changed

- Unknown event kinds, state words and class names read as words instead of raw ids
- Automations can start on, and be conditioned by, a parked object (appeared or departed, with class and zone filters)

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
