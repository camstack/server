# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
