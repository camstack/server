# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-28

### Changed

- Renamed to Dominevo: the package is now published as @dominevo/addon-provider-zigbee-z2m, restarting at version 0.1.0.

## [0.1.1] - 2026-11-27

### Added

- Initial release.

### Changed

- New Zigbee2MQTT integration: connect to an existing Zigbee2MQTT server and see and operate its devices (lights, switches, covers, locks, climate, sensors and buttons)
- The Zigbee network is readable as a device mesh: nodes, roles and link quality from the server's own network map, scanned only when you ask and never waking a battery device.
- A Zigbee2MQTT integration can allow new devices for a set time, rename or remove a device (with a force option) and restart the server, from its settings.
- A Zigbee2MQTT integration can check a device for a firmware update and start it, and shows each device's firmware progress as the server reports it.
- The Zigbee network is described to the mesh view (id, channel, PAN id), each device that can be updated offers a firmware Update device, and a removed device stops following the server.
