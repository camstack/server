# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Email targets pick the Google account or SMTP relay that sends them under Send with; existing targets are linked automatically, and every target kind can send a test from the editor before it is saved.

## [1.2.637] - 2026-11-11

### Changed

- The old per-user notification target calls are gone; the viewer manages its targets as integration instances.

## [1.2.636] - 2026-11-10

### Changed

- Telegram messages can be posted into a forum topic: a rule sets the topic per target.

## [1.2.635] - 2026-11-09

### Changed

- Removed the unused legacy settings-store port adapters
- Notification targets are listed, edited, switched, tested and deleted through the instance door
- A notification target the migration could not move stays served from the retired kind, and the migration runs again on the next boot until it has moved
- The Notification Center keeps working on the previous viewer release: the five my-target actions answer again, as delegates onto the same per-user instance door.
- The email target's provider picker shows a relay that has not sent yet as not checked yet, and not verified only after a failed send.

## [1.2.634] - 2026-11-08

### Changed

- No operator change: the legacy target rows the migration is tested against now live in a replay seed

## [1.2.633] - 2026-11-07

### Changed

- Notification targets are served only as integration instances; the viewer's nc.* target actions keep working with the same secret protection

## [1.2.632] - 2026-11-06

### Changed

- Translations that were silently ignored because the catalog nested its keys are now loaded.

## [1.2.631] - 2026-11-06

### Changed

- Notification targets are instances of the notification function: Telegram, Home Assistant, Alexa and the rest keep their ids, switches and secrets, and rules naming them keep dispatching

## [1.2.630] - 2026-11-06

### Changed

- The email target's relay picker words its empty choice "Default relay" again

## [1.2.629] - 2026-11-06

### Changed

- The email target's relay pin is an instance picker over the email providers' relays

## [1.2.628] - 2026-11-02

### Changed

- An email target's relay is now a picker of the chosen provider's relays by name, with 'Default relay' as the empty choice; a relay that no longer exists shows as 'missing relay <id>'.

## [1.2.627] - 2026-11-02

### Changed

- An email target can be pinned to one relay of its SMTP provider; unpinned targets keep using the first configured relay

## [1.2.626] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.625] - 2026-10-31

### Changed

- A test notification's sample image now reaches the service as an absolute public URL

## [1.2.624] - 2026-10-30

### Changed

- Notification targets pick a broker and list their options inside the add/edit form; the page-wide Find devices dialog is gone

## [1.2.623] - 2026-10-27

### Changed

- Shown as "Notifications"; the email hint names "Google" and "Email (SMTP)".

## [1.2.622] - 2026-10-27

### Added

- Notifications: System notifiers addon for CamStack — a `notification-output` collection provider hosting per-kind notifier adapters (ntfy, pushover, gotify, telegram, discord, webhook, zentik).
- Provides the addon Notifications.
