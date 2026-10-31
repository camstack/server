# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Gree AC that was unreachable at startup now keeps retrying to bind (5 s, 30 s, then every 3 min) and re-binds after the AC stops answering, instead of staying offline until the addon restarts.

## [0.2.146] - 2026-10-30

### Changed

- Gree ACs are searched on every subnet the network scan covers; the per-scan broadcast address form is gone

## [0.2.145] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.144] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.143] - 2026-10-27

### Added

- Gree Provider: Gree air-conditioner device-provider addon for CamStack — wraps the @apocaliss92/nodegree local-UDP client (LAN discovery + AES control), exposing climate-control and fan-control.
- Provides the addon Gree.
