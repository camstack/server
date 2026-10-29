# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.155] - 2026-10-29

### Changed

- The PetKit feeder now polls every 10 s while a feed, eating or a bowl change is in progress (30 s otherwise, backing off on errors), so the bowl weight no longer lags minutes behind the app.

## [0.2.154] - 2026-10-29

### Changed

- The feeder bowl reads only the scale weight in grams; an unproven bowl value is shown as unknown

## [0.2.153] - 2026-10-29

### Changed

- Pet feeder remembers the last manual feed per device and uses it as the next default

## [0.2.152] - 2026-10-28

### Changed

- The FRESHELEMENT 3 feeder shows the grams in its bowl
- A pet feeder shows whether it runs on mains or on its battery

## [0.2.151] - 2026-10-28

### Changed

- PetKit now re-logs in at most once per 5 minutes after the cloud ends the session, stops after repeated kicks and tells you to use a dedicated family account; the account form explains the one-session-per-account rule

## [0.2.150] - 2026-10-27

### Added

- An alert when the PetKit session is lost, e.g. after a sign-in elsewhere

### Fixed

- The feeder reports the food tank and the bowl separately, shows when the pet is eating, lists the tank and the desiccant under Consumables, and offers Mark refilled only on models that support it

## [0.2.149] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.2.148] - 2026-10-27

### Added

- PetKit Provider: PetKit smart-feeder device-provider addon for CamStack — wraps the @apocaliss92/nodepetkit PetKit cloud client.
- Provides the addon PetKit.
