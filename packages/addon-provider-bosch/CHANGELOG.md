# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.34] - 2026-10-31

### Changed

- The Smart Home Controller can be added as a Gateway device next to its rooms and devices, and a discovered controller is proposed as a Gateway.

## [0.1.33] - 2026-10-30

### Changed

- The Bosch Smart Home Controller is now found by the shared network scan, including on other subnets
- Bosch sign-in through the hub keeps the vendor's cookies on the server, fixing the "Browser requirements not met" page

## [0.1.32] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.1.31] - 2026-10-28

### Changed

- The Home Connect and HomeCom sign-in pages open under the shared vendor-login path

## [0.1.30] - 2026-10-27

### Changed

- Home Connect and HomeCom now sign in through a page served by the hub; no more copying the redirect address out of the browser's developer tools.

## [0.1.29] - 2026-10-27

### Changed

- The Smart Home Controller addon is shown as "Bosch Smart Home" (was "Bosch SHC").

## [0.1.28] - 2026-10-27

### Added

- Bosch: Bosch smart-home device-provider addons for CamStack — SHC, Home Connect, and HomeCom cloud integrations (scaffold).
- Provides the addons Bosch Smart Home, Bosch Home Connect, Bosch HomeCom.
