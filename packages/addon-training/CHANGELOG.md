# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Training page dropdowns use the CamStack list (keyboard and screen-reader alike), no visible change otherwise

## [0.1.137] - 2026-11-10

### Changed

- Rebuilt against updated dependencies.

## [0.1.136] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [0.1.135] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [0.1.134] - 2026-11-07

### Changed

- The Modal account migrations now reach their data only through the migration API, so they keep working across version jumps

## [0.1.133] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.1.132] - 2026-11-06

### Changed

- The training-provider capability no longer exposes validateCredentials, createEntry, updateEntry or deleteEntry; a Modal account is created, edited, tested and removed as an integration instance.

## [0.1.131] - 2026-11-05

### Changed

- The Modal provider no longer declares an empty settings form; accounts are managed as records.

## [0.1.130] - 2026-11-04

### Changed

- The integration states its role (devices, services or both) to the Integrations page

## [0.1.129] - 2026-11-04

### Changed

- Modal training accounts are now integration-instance records edited under Training providers; each keeps its id and its token moves into the keychain-backed record on first start

## [0.1.127] - 2026-11-02

### Changed

- The page no longer bundles the UI library; the admin UI provides it, so the page stays unchanged when the library changes.

## [0.1.126] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [0.1.125] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [0.1.124] - 2026-11-01

### Changed

- Rebuilt against updated dependencies.

## [0.1.123] - 2026-11-01

### Changed

- The addon page now ships a list of the library modules it bundles, so a library change the page never reaches no longer republishes it

## [0.1.122] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [0.1.121] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [0.1.120] - 2026-10-31

### Changed

- Admin and addon pages use the library's form controls (Button, Input, Select, Textarea, Checkbox) instead of the browser's; no visible change beyond slightly tighter fields

## [0.1.119] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [0.1.118] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [0.1.117] - 2026-10-31

### Changed

- Rebuilt against updated dependencies.

## [0.1.116] - 2026-10-31

### Changed

- The Frames editor opens the subject of a notification verdict as correct, reclassified or flagged, for you to confirm

## [0.1.115] - 2026-10-31

### Changed

- Opening the Create provider form no longer re-seeds it blank after the first keystroke

## [0.1.114] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [0.1.113] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [0.1.112] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [0.1.111] - 2026-10-30

### Changed

- Rebuilt against updated dependencies.

## [0.1.110] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [0.1.109] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [0.1.108] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [0.1.107] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [0.1.106] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [0.1.105] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [0.1.104] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [0.1.103] - 2026-10-29

### Changed

- Rebuilt against updated dependencies.

## [0.1.102] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [0.1.101] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [0.1.100] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [0.1.99] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [0.1.98] - 2026-10-28

### Changed

- Rebuilt against updated dependencies.

## [0.1.97] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.1.96] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.1.95] - 2026-10-27

### Changed

- Rebuilt against updated dependencies.

## [0.1.94] - 2026-10-27

### Changed

- The cloud trainer is shown as "Modal" (was "Modal (training cloud)").

## [0.1.93] - 2026-10-27

### Added

- Cloud Training: Cloud training for CamStack: fine-tune the root detector on your own frames, on your own GPU-cloud account.
- Provides the addons Training, Modal.
