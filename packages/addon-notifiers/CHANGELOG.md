# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
