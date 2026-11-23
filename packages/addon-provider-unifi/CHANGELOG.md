# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.175] - 2026-11-22

### Changed

- A PoE splitter port now links every camera it feeds, only while the port is delivering PoE; the port label and links no longer flip between cameras

## [0.2.174] - 2026-11-21

### Changed

- Rebuilt against updated dependencies.

## [0.2.173] - 2026-11-19

### Changed

- The UniFi controller is now read on the core's state-refresh schedule (slower reconcile while the live event stream is up) instead of the addon's own timer.

## [0.2.172] - 2026-11-18

### Changed

- Add device inside an integration lists only its own devices, with no network scan
- Uptime and CPU sensors show their unit; uptime reads as a duration.

## [0.2.171] - 2026-11-18

### Changed

- UniFi switches and access points restart from their card, like the console
- UniFi switches and access points no longer have a separate Restart button device; restart from the card
- A UniFi switch or access point with PoE ports shows a power-meter on its own card: the total PoE power it delivers
- A UniFi switch or access point reports its PoE total as delivered power instead of its own power draw

## [0.2.170] - 2026-11-18

### Changed

- Each UniFi console is now a Host device with workload data, its admin link and a Restart on its workload card; the separate Gateway device is gone and an old one is removed on restart

## [0.2.169] - 2026-11-18

### Changed

- A PoE port now reports the device wired to it, so CamStack can link the port to the camera it powers.
- A PoE port whose client left keeps the last MAC as retained, not as a fresh read, so a camera moved to another port follows it.

## [0.2.168] - 2026-11-17

### Changed

- UniFi consoles, switches and access points declare their MAC, serial (with a local account) and IP as device identifiers

## [0.2.167] - 2026-11-17

### Changed

- Re-sync is now offered through the device's own resync capability
- A network scan now finds UniFi OS consoles (Ubiquiti discovery broadcast) and offers them as an integration with the host filled in; access points and switches are not offered.

## [0.2.166] - 2026-11-17

### Changed

- Discovery shows each switch's PoE ports under it, and a poll whose port or sensor read failed no longer removes the adopted port and sensor children
- Each PoE port of a UniFi switch is now its own device under the switch, showing its PoE power, link and the client on it (named after that client); with a local account (username and password) added beside the API key, the port's PoE can be switched on and off — and a camera can use that port as its power source for restarts
- Consoles, switches and access points are adopted as workload hosts showing whether they run, their uptime, CPU and temperature; PoE ports carry the PoE port role and report link up and link speed
- A local account now signs in through aiounifi (the library Home Assistant uses) in a Python worker: PoE on/off keeps every other port's setting, and the controller's live event stream updates port link, PoE and clients between polls.
- An unreachable controller now shows its consoles, switches and access points as unknown instead of still running, and their running-since time no longer moves on every poll.
- A UniFi console, switch or access point that drops off the controller now raises "Went down" (not "Shut down"), and "Came online" when it returns.
- A PoE port seen only through the API key is now a switch that can power-cycle: a camera on it can be force-restarted from its power source.
- The integration status says which credential signed in: the API key, the local account, or both (and when the local account stops answering).
- UniFi hosts report memory use (percent) on their workload, from the Integration API statistics or the local account's device stats.

## [0.2.165] - 2026-11-16

### Changed

- The UniFi connection can be tested from the form with the API key, a failure names its reason (refused key, untrusted self-signed certificate, unreachable, wrong site) instead of "fetch failed", an offline integration says why on its status, and the LED switch the API cannot control is no longer offered

## [0.2.164] - 2026-11-14

### Changed

- Rebuilt against updated dependencies.

## [0.2.163] - 2026-11-12

### Changed

- A new UniFi gateway is named "UniFi" plus the console model when the controller reports one.

## [0.2.162] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.2.161] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.160] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.159] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.2.158] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.157] - 2026-11-05

### Changed

- Internal: the connection form comment names the instance form; no behaviour change.

## [0.2.156] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.155] - 2026-11-04

### Changed

- UniFi controllers are now typed records under their integration; the API key and password stay in the keychain and the legacy settings rows are moved and cleared on first start

## [0.2.154] - 2026-11-01

### Changed

- The UniFi integration shows the Ubiquiti brand icon.
- Connect a UniFi OS console through its API key (Network Integration API): infrastructure devices and client presence are read, restart and port power-cycle work; PoE toggle and LED are not offered by that API. New option to accept the console's self-signed certificate.

## [0.2.153] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.2.152] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [0.2.151] - 2026-11-01

### Changed

- UniFi is now added as an integration: the controller connection and credentials are the integration's settings, and the controller appears as a Gateway beside its infra devices and clients instead of a Hub.
- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.150] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.149] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.148] - 2026-10-27

### Added

- UniFi Network Provider: UniFi Network controller device-provider addon for CamStack — local-controller infra switches/APs (as containers) + network-client presence. No cameras.
- Provides the addon UniFi Network.
