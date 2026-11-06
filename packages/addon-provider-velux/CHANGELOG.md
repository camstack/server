# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.161] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update
- Test on a Velux gateway integration logs in to the KLF-200 with the host and password, on a saved integration or an unsaved form.

## [0.2.160] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.159] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.158] - 2026-11-04

### Changed

- Velux gateways are now typed records under their integration; the gateway password stays in the keychain and the legacy settings rows are moved and cleared on first start

## [0.2.157] - 2026-11-03

### Changed

- The window rain sensor now carries its leak-sensor role, so its device page shows the rain state instead of waiting forever.

## [0.2.156] - 2026-11-02

### Changed

- The Velux gateway session switches the house status monitor off before every close, serialises its requests, waits 30 s before reconnecting, and restarts a wedged gateway through its linked power source after 10 minutes unreachable (at most every 30 minutes).
- Velux covers declare cover-stoppable so their stop control stays exported.

## [0.2.155] - 2026-11-01

### Changed

- The Velux connection test opens a single connection to the gateway and allows its slow TLS handshake, and names whether the handshake or the password answer ran out.

## [0.2.154] - 2026-11-01

### Changed

- The gateway connection test now names the step that timed out (TCP, secure login, version, close) within 17 s and frees the session, instead of hanging until the wizard gives up; an empty gateway scan is logged.

## [0.2.153] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.2.152] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [0.2.151] - 2026-10-30

### Changed

- A Velux gateway is now found by the shared network scan, including on other subnets

## [0.2.150] - 2026-10-30

### Changed

- Fix the Velux addon failing to talk to the gateway when deployed: the bundled output now carries every KLF-200 frame decoder instead of looking for files beside it
- Velux is now an integration: add it from Integrations (the KLF-200 on your network is offered automatically), test the login, and adopt the Gateway (reboot, firmware, web link), windows with a rain sensor, and covers. The old standalone Velux device is removed; add the gateway again.

## [0.2.149] - 2026-10-29

### Changed

- Velux KLF-200 now connects for real: windows, shutters, blinds and awnings are covers whose state is pushed by the gateway, a roof window's rain sensor is a leak sensor, and a dropped session reconnects by itself (see the addon README for the gateway's two-connection limit)

## [0.2.148] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.147] - 2026-10-27

### Added

- Velux Provider: Velux KLF-200 device-provider addon for CamStack — local-gateway window + shutter covers (positional, no tilt).
- Provides the addon Velux.
