# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- MQTT thermostats are now climate devices.

## [0.1.44] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.1.43] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.1.42] - 2026-11-06

### Changed

- Translations that were silently ignored because the catalog nested its keys are now loaded.

## [0.1.41] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.1.40] - 2026-11-06

### Changed

- MQTT Discovery integrations link to an MQTT broker through the shared instance link: the broker picker is the instance picker, deleting a linked broker is refused, and integrations with no broker are flagged unconfigured

## [0.1.39] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.1.38] - 2026-11-05

### Fixed

- MQTT discovery sensors get a device role, so their state shows instead of waiting for a temperature.
- MQTT discovery switches whose state template is an if-block, such as a Velux plug, report on and off.

## [0.1.37] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

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
