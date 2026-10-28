# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.184] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.183] - 2026-10-27

### Added

- HomeKit Export: HomeKit (HAP) exporter for CamStack devices. Publishes each exposed device as its own HomeKit accessory: cameras and doorbells with SRTP streaming, HomeKit Secure Video, motion, two-way audio, PTZ and battery; switches, lights, locks and sensors through a capability→service table.
- Provides the addon HomeKit Export.
