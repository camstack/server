# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The Homematic CCU is found by the shared network scan, including on other subnets

## [1.2.163] - 2026-10-30

### Changed

- A Homematic CCU3 / RaspberryMatic is now added as an integration (host, interfaces, optional WebUI login) with a connection test and LAN discovery, and appears as a Gateway device with a link to its WebUI; devices are adopted beside it. Remove and re-add an existing CCU.

## [1.2.162] - 2026-10-29

### Changed

- Homematic value changes now log (debug) when accepted and when dropped, with the reason

## [1.2.161] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.160] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.159] - 2026-10-27

### Added

- Homematic Provider: Homematic / HomematicIP (CCU3 / RaspberryMatic) device-provider addon for CamStack — wraps the nodehomematic library.
- Provides the addon Homematic.
