# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.1.42] - 2026-11-06

### Changed

- Translations that were silently ignored because the catalog nested its keys are now loaded.

## [0.1.41] - 2026-11-06

### Changed

- The separate connection-test capability is gone; the integration's own Test button now checks the saved or drafted settings

## [0.1.40] - 2026-11-06

### Changed

- Switching the integration on or off now applies at once and a disabled integration stays disabled after the update

## [0.1.39] - 2026-11-06

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.1.38] - 2026-11-05

### Changed

- Bosch sign-in through the hub: proxy the SingleKey ID script host so the login page shows its password step instead of only the email field

## [0.1.37] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.1.36] - 2026-11-04

### Changed

- Bosch Smart Home, Home Connect and HomeCom keep each account as a typed instance on the Integrations page; the saved connections move over on first start, and tokens and pairing keys stay in the keychain

## [0.1.35] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

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
