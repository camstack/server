# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
