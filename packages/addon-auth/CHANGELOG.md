# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
