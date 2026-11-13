# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.50] - 2026-11-13

### Changed

- Rebuilt against updated dependencies.

## [0.2.49] - 2026-11-13

### Changed

- A Google account has its own mark, so an email target badges the account instead of the Google addon's calendar icon.
- Gmail sends notification images in the same MIME body as SMTP.

## [0.2.48] - 2026-11-13

### Changed

- A Google account can be picked as the sender of an email notification, and mail goes out from exactly that account.

## [0.2.47] - 2026-11-10

### Changed

- Google accounts keep their sign-in (refresh token through the keychain, email, scopes) on the account itself; the old OAuth state is moved once at boot, with no new consent

## [0.2.46] - 2026-11-09

### Changed

- Gmail send provider drops the unused verify call

## [0.2.45] - 2026-11-09

### Fixed

- Each imported calendar names the record that owns it, so its switch is found on the Calendars page
### Changed


## [0.2.44] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.2.43] - 2026-11-07

### Changed

- The addon-level Google settings pointer form is removed; setup lives on the Brokers page

## [0.2.42] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.2.41] - 2026-11-06

### Changed

- The addon-level brokers setting and legacy single-account oauth state are removed once broker records and oauthAccounts hold them

## [0.2.40] - 2026-11-06

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
