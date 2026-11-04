# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The instances state their role (service connections) so the Integrations page lists the addon correctly

## [1.2.149] - 2026-11-03

### Changed

- External MQTT brokers are now integration instances: they list on the Integrations page, an instance can be switched off, and the old settings list is migrated into records and removed.

## [1.2.148] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.147] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.146] - 2026-10-27

### Added

- MQTT Broker: MQTT broker registry addon for CamStack — manages external broker entries + an optional embedded aedes broker. Consumers spin up their own `mqtt.js` clients via the `mqtt-broker` cap.
- Provides the addon MQTT Broker.
