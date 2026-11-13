# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.21] - 2026-11-13

### Changed

- An ESPHome IR transmitter records each send and each learn it attempts. Refusing because the board cannot learn is not stored as a failed learn.

## [0.1.20] - 2026-11-12

### Changed

- ESPHome IR transmitters report that they cannot learn and keep sending pulse trains

## [0.1.19] - 2026-11-12

### Changed

- Event devices declare their event vocabulary; each event is listed under its native name for now
- Event devices show readable event names, and common button events (press, long press, double press, release) are recognised as such

## [0.1.18] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.1.17] - 2026-11-08

### Changed

- The ESPHome board creation form keeps the encryption key and password as secrets.
- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.1.16] - 2026-11-06

### Changed

- Translations that were silently ignored because the catalog nested its keys are now loaded.

## [0.1.15] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.1.14] - 2026-11-06

### Changed

- Internal: the registry status type no longer depends on the retired broker row type

## [0.1.13] - 2026-11-05

### Changed

- Boards are added from the integration page (found on the network, or by entering the host); the integration settings no longer list boards, and an encrypted board asks for its API encryption key only.

## [0.1.12] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.1.11] - 2026-11-05

### Fixed

- A board that connects while its devices are still being restored no longer tries to register each control twice, and a repeated entity stays one device.

## [0.1.10] - 2026-11-04

### Changed

- ESPHome integrations are kept as typed connection records: each board keeps its id and its own encryption key and password, moved once from the old integration settings

## [0.1.9] - 2026-11-02

### Changed

- ESPHome: an Import keys action reads each board's API encryption key from the ESPHome Builder through Home Assistant and reports every board it could not read, with the reason.

## [0.1.8] - 2026-11-02

### Changed

- ESPHome covers that can stop declare cover-stoppable so their stop control stays exported.

## [0.1.7] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.1.6] - 2026-10-30

### Changed

- ESPHome is now one integration holding several boards: add or remove a board without touching the others, each board keeps its own device and encrypted key; existing boards migrate automatically
- ESPHome shows its real logo
- ESPHome boards are found by the shared network scan, including on other subnets; several scanned boards can be picked at once

## [0.1.5] - 2026-10-28

### Changed

- Each ESPHome board service that takes only a pulse train becomes an infrared transmitter device; the list can be overridden per board.

## [0.1.4] - 2026-10-28

### Changed

- ESPHome boards' own actions (API services) can be listed and run, e.g. an IR blaster's send_raw_command

## [0.1.3] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.1.2] - 2026-10-27

### Added

- First release: one broker per ESPHome board over the native API (Noise or plain), mDNS discovery, and adoption of a connected board as a container with a child per entity (switch, light, cover, button, number, select, event, sensor, text sensor, binary sensor, power meter).
- Bounded reconnect backoff; a refused key or password is reported as `auth-failed` and not retried.
