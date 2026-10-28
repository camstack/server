# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A pet feeder shows whether it runs on mains or on its battery
- Pure IR/RF codecs: pulse-train and transmit-settings schemas, Pronto decoding and SmartIR media_player import.

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
