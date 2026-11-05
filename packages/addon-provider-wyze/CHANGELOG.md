# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Its data migrations now run through the stable migration API, so an old migration keeps working after a version jump

## [0.2.164] - 2026-11-05

### Changed

- The account form is declared as the integration instance form; the form and stored accounts are unchanged.

## [0.2.163] - 2026-11-05

### Changed

- Copying an integration into its record reads the leftover rows through the migration-only door and resolves their secrets in this addon

## [0.2.162] - 2026-11-04

### Changed

- Wyze accounts are now typed records under their integration; the password and the API key stay in the keychain and the legacy settings rows are moved and cleared on first start

## [0.2.161] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.160] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.159] - 2026-10-27

### Added

- Wyze Provider: Wyze camera device-provider addon for CamStack — wraps the @apocaliss92/wyze-bridge-js P2P/DTLS client, feeding the stream-broker via the pull-rfc4571 lazy-publish path (a structural twin of addon-provider-reolink).
- Provides the addon Wyze.
