# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.130] - 2026-11-07

### Changed

- Rebuilt against updated dependencies.

## [0.1.129] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.1.128] - 2026-11-06

### Changed

- Reads the instance switch through the shared isInstanceEnabled helper; behaviour unchanged

## [0.1.127] - 2026-11-05

### Changed

- Rebuilt against updated dependencies.

## [0.1.126] - 2026-11-04

### Changed

- Google Home export now supports several instances, one per Actions-console project: each has its own devices and linked accounts, with fulfillment URL /fulfillment/<instance id>; the existing setup keeps working at /fulfillment

## [0.1.125] - 2026-11-04

### Changed

- The devices and actions exposed to Google Home are kept in their own record instead of the addon settings; they move across on the first start and the addon refuses to start if they cannot be moved.

## [0.1.124] - 2026-11-04

### Changed

- Export calls name the export instance they address; an unknown instance is refused with export-instance-unknown

## [0.1.123] - 2026-11-02

### Changed

- The retired public hub URL settings are now removed from the settings table where they are actually stored

## [0.1.122] - 2026-11-02

### Changed

- The Google export no longer has a Public hub URL setting or a Detect external address button: the console URLs follow the Public endpoint address of the Network page, and say so when none is set.

## [0.1.121] - 2026-11-02

### Changed

- Google Home can run your actions as scenes: expose an action and say 'activate <name>'; only admins can run them

## [0.1.120] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.1.119] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [0.1.118] - 2026-10-29

### Changed

- Runs in the shared integrations runner with the other low-traffic integration addons, saving one process of memory (restarting it restarts them together)

## [0.1.117] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [0.1.116] - 2026-10-27

### Changed

- Shown as "Google Home Export".

## [0.1.115] - 2026-10-27

### Added

- Google Home Export: Google Home Export — hub-side smart-home fulfillment (SYNC / QUERY / EXECUTE / DISCONNECT) for the non-camera fleet, served over the hub's own OAuth account link. No Google credential is stored, sent or required.
- Provides the addon Google Home Export.
