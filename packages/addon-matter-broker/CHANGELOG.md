# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
