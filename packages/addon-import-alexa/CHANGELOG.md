# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.2.161] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [0.2.160] - 2026-10-28

### Changed

- The Amazon sign-in button opens the login again; the sign-in page now lives under a path no addon route shares

## [0.2.159] - 2026-10-27

### Added

- The Amazon sign-in now opens through the hub over HTTPS; the login proxy host setting and the published port are no longer needed.

## [0.2.158] - 2026-10-27

### Fixed

- Alexa sign-in follows Amazon's current login pages

## [0.2.157] - 2026-10-27

### Fixed

- Amazon sign-in for the Alexa broker can be retried after a cancelled attempt, and the sign-in link now uses the hub's LAN address from the Network page instead of the first network interface
- Alexa sign-in follows Amazon's current login pages (library update)

## [0.2.156] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.155] - 2026-10-27

### Changed

- Echo speech signs in as the import broker (its refresh token) instead of a
  separate Amazon login; one worker and one cookie jar per broker. The Speak
  on Echo page no longer signs in. An old standalone login migrates onto the
  single broker, or is dropped with a named state when there are none or several.
- The Alexa target form picks the Echo from the account's device list.
- The Alexa kind serves the Alexa brand mark as its icon.
