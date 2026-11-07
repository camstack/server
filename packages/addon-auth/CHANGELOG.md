# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- OpenID Connect connections are instances of the sign-in function: an operator-chosen id, a per-connection On/Off switch, and the client secret stays in the keychain

## [1.2.177] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.176] - 2026-11-05

### Changed

- The OIDC addon no longer declares an empty settings form; connections are managed as records.

## [1.2.175] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.174] - 2026-10-31

### Changed

- Admin and addon pages use the library's form controls (Button, Input, Select, Textarea, Checkbox) instead of the browser's; no visible change beyond slightly tighter fields

## [1.2.173] - 2026-10-31

### Changed

- Authentication addons are now hub-only: they are removed from agents that still carry them

## [1.2.172] - 2026-10-30

### Changed

- OIDC connections with a client secret save again: each write touches only its own connection

## [1.2.171] - 2026-10-30

### Changed

- Editing, deleting or adding an OIDC connection no longer fails with a foreign secret marker error, and a connection without a client secret (public client) is accepted

## [1.2.170] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [1.2.169] - 2026-10-27

### Added

- Authentication: Authentication bundle — OIDC and WebAuthn/passkey. Multi-entry npm package shipping 2 addons under a single bundle; each addon keeps its own id, capabilities, and runner.
- Provides the addons OpenID Connect, Passkey.
