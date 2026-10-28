# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
