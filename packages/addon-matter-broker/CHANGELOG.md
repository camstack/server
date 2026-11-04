# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
