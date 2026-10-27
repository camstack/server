# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.147] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.146] - 2026-10-27

### Added

- MQTT Broker: MQTT broker registry addon for CamStack — manages external broker entries + an optional embedded aedes broker. Consumers spin up their own `mqtt.js` clients via the `mqtt-broker` cap.
- Provides the addon MQTT Broker.
