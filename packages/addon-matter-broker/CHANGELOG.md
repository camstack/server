# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A Matter device that stayed offline for a while is now really redialled on each retry, instead of the retry failing at once.

## [0.1.0] - 2026-11-28

### Changed

- A Matter device that went offline is dialled again instead of waiting for it to announce itself, and boot opens a single session per device

## [0.2.183] - 2026-11-27

### Changed

- The mesh topology names the Thread network (name, extended PAN id, channel)

## [0.2.182] - 2026-11-27

### Changed

- Matter nodes report their network: Thread links, signal, role, power source and diagnostics; mains-powered nodes are re-read every 15 minutes, battery nodes only when asked
- Device mesh: the 15-minute refresh no longer starts a second pass while one is still running

## [0.2.181] - 2026-11-26

### Changed

- After a restart a Matter device shows its last known state instead of a default.
- A Matter lock stays 'status unknown' until its first lock reading arrives, and is re-read until one does, instead of being presented as online and unlocked.
- A Matter node that dropped offline is now re-subscribed every 15 to 60 seconds, and keeps retrying every minute until the device answers, instead of waiting up to an hour on the library's silent retry.
- Matter library messages (connection and session problems) now appear in the addon log instead of being lost.

## [0.2.180] - 2026-11-26

### Changed

- A Matter lock with the Unbolting feature now offers Open (unlock only unbolts, Open unlatches), and a battery reported on a separate power-source endpoint shows on the lock instead of as a 'Parts' device.

## [0.2.179] - 2026-11-26

### Changed

- Matter: a commissioned lock's endpoints now report their server clusters, so its door lock and power source children appear

## [0.2.178] - 2026-11-25

### Changed

- Fixed Matter attribute subscriptions failing with 'at least one must be specified'; a second fabric that cannot bind the shared port now logs one plain line

## [0.2.177] - 2026-11-25

### Changed

- Matter devices now subscribe to their attributes again; the functions a paired device reports are read and logged.

## [0.2.176] - 2026-11-25

### Changed

- A Matter fabric no longer stays locked after a container restart; refused publishes now say why in the log.

## [0.2.175] - 2026-11-24

### Changed

- Matter commissioning failures are now logged with the reason, and a node that joined the fabric is no longer reported as failed when its first subscription fails
- A Matter fabric comes back after a restart: the stale storage pid lock no longer keeps it down

## [0.2.174] - 2026-11-22

### Changed

- Adding a Matter fabric or integration no longer asks for a restore id

## [0.2.173] - 2026-11-21

### Changed

- Rebuilt against updated dependencies.

## [0.2.172] - 2026-11-19

### Changed

- An instance's on/off switch is read from the hub registry row, and moved there from the record on first boot

## [0.2.171] - 2026-11-17

### Changed

- A battery on this device reports charge only; it no longer pretends to answer a camera wake
- Re-sync is now offered through the device's own resync capability

## [0.2.170] - 2026-11-17

### Changed

- Matter locks report whether a PIN is required in their state (codeRequired) instead of a device feature.

## [0.2.169] - 2026-11-14

### Changed

- Matter: door locks report lock and door state, lock operations, alarms and button presses become device events, and leak, smoke, CO, valve and air-quality devices are mapped; an unreachable node shows offline instead of its last state.

## [0.2.168] - 2026-11-12

### Changed

- A Matter thermostat turns on and off through its switch, like every other device

## [0.2.167] - 2026-11-11

### Changed

- A Matter thermostat endpoint is imported as a climate device.

## [0.2.166] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.2.165] - 2026-11-09

### Changed

- The connection form of an instance is served only by the one instance door; the addon-level form hook is gone

## [0.2.164] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.163] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [0.2.162] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.161] - 2026-11-06

### Changed

- Removed the broker-select field type; every broker link is now an instance-select field on the one link primitive
- Removed the deprecated broker-named in-use helpers; a delete refused for a linked instance is the one InstanceInUseError
- Reads the instance switch through the shared isInstanceEnabled helper; behaviour unchanged

## [0.2.160] - 2026-11-06

### Changed

- Matter fabrics are served as instances next to the integrations, so the Brokers section reads them from the shared instances list
- Deleting a Matter fabric is refused while an integration still uses it, on the instances page
- A Matter fabric is referenced by id from its integration and owns nothing of it; deleting a fabric still in use is refused with the list of users

## [0.2.159] - 2026-11-05

### Changed

- The integration form is declared as the instance form (the connection form); fabrics and their stored values are unchanged.

## [0.2.158] - 2026-11-05

### Changed

- The Matter manifest declares multiple instances, as the integration already allowed.

## [0.2.157] - 2026-11-05

### Changed

- A Matter integration links to its fabric through the fabric record

## [0.2.156] - 2026-11-04

### Changed

- The integration states its role (devices, services or both) to the Integrations page

## [0.2.155] - 2026-11-04

### Changed

- Matter fabrics are listed on the instances page; their stored settings are flattened once at start-up (same ids, Thread dataset and Wi-Fi password kept).

## [0.2.154] - 2026-11-02

### Changed

- Matter window coverings declare cover-stoppable so their stop control stays exported.

## [0.2.153] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.152] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.151] - 2026-10-27

### Added

- Live attribute subscriptions (resubscribe with a bounded backoff) and Door Lock state, including lock and unlock.
- An admin "Add Matter device" flow: paste a share code and see commissioning progress and named failures.

### Changed

- `threadDataset` is a secret. Settings reads return it blank, same as the Wi-Fi password.
