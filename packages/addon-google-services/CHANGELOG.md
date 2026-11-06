# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Google calendars are now their own instances under Connectivity → Calendars; the account's calendar list is migrated into them

## [0.2.39] - 2026-11-06

### Changed

- Google accounts declare the function they serve on their instance kind
- Google accounts are managed only on the instances page; the broker CRUD is gone

## [0.2.38] - 2026-11-04

### Changed

- The integration states its role (devices, services or both) to the Integrations page

## [0.2.37] - 2026-11-04

### Changed

- Google accounts are listed and edited as integration instances on the instances table, under their existing ids

## [0.2.36] - 2026-11-03

### Changed

- Each Google account now keeps its own list of calendars to import; the shared list is copied to every account on first start.

## [0.2.35] - 2026-11-02

### Changed

- Rebuilt against updated dependencies.

## [0.2.34] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.2.33] - 2026-10-27

### Changed

- Shown as "Google" (was "Google Services").

## [0.2.32] - 2026-10-27

### Added

- Google: Google Services — Google brokers (OAuth2): Calendar as calendar-source, Gmail send as smtp-provider.
- Provides the addon Google.
