# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.151] - 2026-10-27

### Added

- Live attribute subscriptions (resubscribe with a bounded backoff) and Door Lock state, including lock and unlock.
- An admin "Add Matter device" flow: paste a share code and see commissioning progress and named failures.

### Changed

- `threadDataset` is a secret. Settings reads return it blank, same as the Wi-Fi password.
