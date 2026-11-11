# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A remote or wall switch lists each button with its presses (short, long, held, released), and a press says which button it came from

### Changed

- A Homematic thermostat turns on and off through its switch, like every other device

## [1.2.190] - 2026-11-11

### Changed

- Homematic thermostats are now climate devices: a radiator valve gets the radiator role, a floor-heating actuator the floor role, any other thermostat the thermostat role.
- Event devices declare their event vocabulary; each event is listed under its native name for now

## [1.2.189] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.188] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [1.2.187] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [1.2.186] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.185] - 2026-11-06

### Changed

- Test on a Homematic CCU integration checks the interfaces and the WebUI login, on a saved integration or an unsaved form.

## [1.2.184] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [1.2.183] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [1.2.182] - 2026-11-04

### Changed

- Homematic CCUs are kept as typed connection records, each moved once from the old integration settings with its own connection and WebUI password
- Homematic CCU connections and the discovery of known hosts are read only from the integration record

## [1.2.181] - 2026-11-02

### Changed

- Homematic covers declare cover-stoppable so their stop control stays exported.

## [1.2.180] - 2026-11-02

### Changed

- The page no longer bundles the UI library; the admin UI provides it, so the page stays unchanged when the library changes.

## [1.2.179] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.178] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.177] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [1.2.176] - 2026-11-01

### Changed

- The addon page now ships a list of the library modules it bundles, so a library change the page never reaches no longer republishes it

## [1.2.175] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [1.2.174] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [1.2.173] - 2026-10-31

### Changed

- The CCU connection form explains why WebUI credentials are needed and prefills the username with Admin.

## [1.2.172] - 2026-10-31

### Changed

- The CCU network scan now finds a CCU that answers the probe with a JSON-RPC error, a WebUI username alone (empty password) now unlocks device names, and a missing-names warning is logged.

## [1.2.171] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.170] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.169] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.168] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.167] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [1.2.166] - 2026-10-31

### Changed

- New Homematic CCU page under Administration: CCU version, interface health and duty cycle, and service messages you can acknowledge.
- Homematic CCU page: a Devices tab with firmware, signal, duty cycle, low battery, unreachable, config pending and sabotage per device.
- Homematic CCU page: heating tab lists groups and thermostats and creates, edits and deletes heating groups behind a confirmation
- Homematic CCU page: pairing tab opens learn mode on BidCos-RF and HmIP-RF and lists new devices live; devices can be deleted from the CCU with a factory-reset option, each behind a confirmation
- Homematic CCU page: edit a device channel's MASTER parameters (changed values only, behind a confirmation)

## [1.2.165] - 2026-10-31

### Changed

- Uses nodehomematic 0.5.1.

## [1.2.164] - 2026-10-30

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
