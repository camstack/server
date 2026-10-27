# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First release: one broker per ESPHome board over the native API (Noise or plain), mDNS discovery, and adoption of a connected board as a container with a child per entity (switch, light, cover, button, number, select, event, sensor, text sensor, binary sensor, power meter).
- Bounded reconnect backoff; a refused key or password is reported as `auth-failed` and not retried.
