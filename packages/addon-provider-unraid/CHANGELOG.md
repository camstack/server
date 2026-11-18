# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.173] - 2026-11-18

### Changed

- An APC or other UPS on an Unraid server is now offered as its own device (battery, power drawn, status, runtime, load, voltages)

## [0.2.172] - 2026-11-18

### Changed

- The Unraid server is now its own Host device (WebGUI link, identifiers, CPU, temperature, array as disk); the separate Gateway device is gone and an old one is removed on restart

## [0.2.171] - 2026-11-17

### Changed

- The Unraid server declares its SMBIOS uuid, NIC MACs, flash GUID, hostname and LAN IP, and a VM its domain uuid, as device identifiers

## [0.2.170] - 2026-11-17

### Changed

- Re-sync is now offered through the device's own resync capability
- A network scan now finds Unraid servers (their GraphQL endpoint on port 80, or 443 over TLS) and offers them as an integration with host, port and scheme filled in.

## [0.2.169] - 2026-11-17

### Changed

- Every disk and Docker container of a server gets its own entity: they no longer collapse onto one because their ids share the server prefix
- VMs are read from the server with their run state; a VM list that cannot be read (VM service off) no longer affects the rest of the server
- Docker containers and VMs are proposed one by one in Add devices and adopted as their own devices, no longer created as switches under the server; a container or VM list that cannot be read removes nothing
- The server, each Docker container and each VM are adopted as workload devices: a container starts, stops, restarts (stop then start, as before), pauses and resumes, a VM also reboots and force-stops, each container and VM gets a power switch and shows its state, image, autostart and update status, and names the server as its host
- A container workload shows its memory use, which was read and not shown
- An Unraid server that stops answering now reports as down (raising the host's 'went down', then 'back online' when it answers again) and its containers and VMs read unknown, instead of all of them staying 'running' on the last poll
- Upgrading removes the per-container switch children an existing server had under it; there is no migration: delete them first if you prefer, then adopt the Docker containers and VMs again from Add devices, where each comes back as its own workload device
- An HTTP 404 from the Unraid API now says so: the connection test and the offline reason name the URL and tell you to use http on port 80 with an API key

## [0.2.168] - 2026-11-16

### Changed

- The Unraid connection can be tested from the form: a refused API key is named before the integration is created

## [0.2.167] - 2026-11-14

### Changed

- Rebuilt against updated dependencies.

## [0.2.166] - 2026-11-13

### Changed

- A stored entity whose device type was retired no longer fails to restore

## [0.2.165] - 2026-11-12

### Changed

- A new Unraid gateway is named "Unraid" plus the server hostname when it was read.

## [0.2.164] - 2026-11-12

### Changed

- Event devices declare their event vocabulary; each event is listed under its native name for now
- The notification event is listed under a readable name

## [0.2.163] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.2.162] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.161] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.160] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.2.159] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.158] - 2026-11-05

### Changed

- Internal: the connection form comment names the instance form; no behaviour change.

## [0.2.157] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.156] - 2026-11-04

### Changed

- Unraid servers are now typed records under their integration; the API key stays in the keychain and the legacy settings rows are moved and cleared on first start

## [0.2.155] - 2026-11-01

### Changed

- The Unraid integration shows the Unraid brand icon.
- Unraid integrations now connect to the Unraid API with the configured API key and report the array, disks, docker containers, CPU and active notifications
- Unraid integrations now connect to the Unraid API with the configured API key and report the array, disks, docker containers, CPU and active notifications (an option accepts a self-signed certificate; a failed CPU or container-stats sample reads as unknown, not 0)

## [0.2.154] - 2026-11-01

### Changed

- An integration deleted while its provider was down now has its orphan devices removed after two concordant reads of the integration list

## [0.2.153] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X
- Integration reconcile no longer removes devices when the integration list or settings read fails or is empty; devices are removed only on an explicit Deleted/Disabled event

## [0.2.152] - 2026-11-01

### Changed

- Unraid is now added as an integration: the server host and API key are the integration's settings, and the server appears as a Gateway next to its instance device instead of a Hub.
- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.151] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.150] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.149] - 2026-10-27

### Added

- Unraid Provider: Unraid device-provider addon for CamStack — one Container per Unraid instance fanning out array, disk, docker and notification entities.
- Provides the addon Unraid.
