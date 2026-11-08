# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.147] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [1.2.146] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.145] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.144] - 2026-11-04

### Changed

- The instances state their role (service connections) so the Integrations page lists the addon correctly

## [1.2.143] - 2026-11-02

### Changed

- TURN servers are now records on the TURN Servers page: add several servers, each with its own switch; the existing server moves over on first start

## [1.2.142] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.141] - 2026-10-27

### Changed

- Shown as "TURN Server" (was "Static TURN (coturn / custom)").

## [1.2.140] - 2026-10-27

### Added

- TURN Server: Static / self-hosted (coturn) TURN provider for CamStack.
- Provides the addon TURN Server.
