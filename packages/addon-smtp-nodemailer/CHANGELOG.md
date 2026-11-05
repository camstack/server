# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- SMTP relays and inbound mailboxes are served as instances of one provider
- Inbound mailboxes are managed only on the instances page; the broker CRUD is gone
- Removing an inbound mailbox that a camera email push still reads is refused with the list of subscribers
- Testing a new inbound mailbox before it is created checks that its port can be taken again.

## [1.2.148] - 2026-11-05

### Changed

- The relay form is declared as the integration instance form; the form and stored relays are unchanged.

## [1.2.147] - 2026-11-04

### Changed

- The instances state their role (service connections) so the Integrations page lists the addon correctly

## [1.2.146] - 2026-11-02

### Changed

- Email (SMTP) can now receive mail too: a new inbound mailbox broker kind (smtp-inbound) that cameras send alarm mail to, with the camera-facing address taken from the Network page's Internal address; a mailbox whose port is busy at start is retried, one whose keychain was locked is applied when it unlocks, and an oversized message is refused with 552.
- A mail relay can be switched off: the default relay skips it and a send pinned to it is refused with a clear message

## [1.2.145] - 2026-11-02

### Changed

- SMTP relays are stored as records, each with its own keychain password and an id a notification can pin; the Email settings page is unchanged and edits your default relay, and your current relay is moved there on first start.

## [1.2.144] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.143] - 2026-10-27

### Changed

- Shown as "Email (SMTP)" (was "SMTP Email (Nodemailer)").

## [1.2.142] - 2026-10-27

### Added

- Email (SMTP): SMTP email provider addon for CamStack — wraps `nodemailer` and registers a `smtp-provider` cap collection entry. Used by notifier addons.
- Provides the addon Email (SMTP).
