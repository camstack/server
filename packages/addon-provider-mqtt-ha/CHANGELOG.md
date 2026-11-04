# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.36] - 2026-11-04

### Changed

- MQTT Discovery integrations keep their MQTT broker link as a typed instance record with a broker picker; existing links are migrated on the first start

## [0.1.35] - 2026-11-03

### Changed

- A zigbee2mqtt switch no longer fails to start with a missing-schema error, so its state is served again

## [0.1.34] - 2026-11-03

### Changed

- MQTT discovery no longer loses its broker session when it starts before the MQTT broker is ready, raises a connection-lost alert when the broker is unreachable or refuses the login, and shows a switch that never reported as unknown instead of off

## [0.1.33] - 2026-11-01

### Changed

- Zigbee2MQTT and other bridges that publish discovery with a node id are now seen: every plug and sensor appears in Adopt

## [0.1.32] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.1.31] - 2026-10-31

### Changed

- The integration now shows the MQTT logo instead of a placeholder circle.

## [0.1.30] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.1.29] - 2026-10-27

### Added

- zigbee2mqtt devices import as ONE device each: every entity of a discovery
  `device` block is grouped, and mapped by component, `device_class` and unit
  onto existing caps (switch, brightness, colour temperature, contact, motion,
  temperature, humidity, illuminance, battery, climate, event emitter). Power,
  energy, voltage and current fold into the load's `power-meter`. JSON state
  topics are read through each entity's `value_template`.
- Light, thermostat and event-emitter device types.
