# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.59] - 2026-11-25

### Removed

- Every hub tool authenticates through the camstack login session only: --token, --token-file and CAMSTACK_TOKEN were removed; the new hub-access skill says how.

### Changed

- The logs export tool takes zip: true to save the export as a .zip and still summarises the lines inside.

## [0.1.58] - 2026-11-23

### Changed

- Setup wizard text is no longer mangled by the output scrubber, and a secret flag on a schema field is kept

## [0.1.57] - 2026-11-22

### Changed

- The hub connection states which saved session (user and hub) it acts as

## [0.1.56] - 2026-11-21

### Changed

- Concurrent tools (hub.mjs, deploy, the ops MCP) no longer revoke the shared login session: a session refresh now takes a cross-process lock and reuses a rotation another process already made

## [0.1.55] - 2026-11-19

### Changed

- An instance's on/off switch is read from the hub registry row, and moved there from the record on first boot

## [0.1.54] - 2026-11-16

### Changed

- Shared hub downloader and logs-export helpers for the MCP servers
- The capability skill asks you to audit the device card, the device row and the viewer accessory row a device capability change reaches, and records it in the done-gate

## [0.1.53] - 2026-11-12

### Changed

- The exporter scaffold implements setExposedName.

## [0.1.52] - 2026-11-10

### Added

- Hub discovery reads the hub id a hub announces on the LAN

## [0.1.51] - 2026-11-08

### Changed

- The addon scaffolds for an integration, a service and an exporter now declare their instance kind, so a generated addon loads

## [0.1.50] - 2026-11-08

### Changed

- The addon authoring skill no longer names the deleted addon-level settings hooks.

## [0.1.49] - 2026-11-07

### Changed

- The addon scaffold teaches the scoped settings declaration instead of naming the retired global settings hook

## [0.1.48] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [0.1.47] - 2026-11-06

### Changed

- Reads the instance switch through the shared isInstanceEnabled helper; behaviour unchanged

## [0.1.46] - 2026-11-05

### Fixed

- The exporter scaffold no longer stubs empty device-settings methods.

## [0.1.45] - 2026-11-05

### Changed

- scaffold_addon gains device-integration, service-integration and exporter kinds built on typed integration instances; find_example points at the real implementations and the public addon-examples; traps list the integration rules

## [0.1.44] - 2026-11-01

### Changed

- camstack-secrets skill: the external keychain master key is the fixed mounted path /run/secrets/camstack-master-key, not a config.yaml key

## [0.1.43] - 2026-11-01

### Changed

- Skills and scaffolds updated for the single framework package and the required server minimum

## [0.1.42] - 2026-11-01

### Changed

- The login hints now name the browser approval for a terminal with no TTY
- A saved sign-in session file is written atomically and always ends up 0600, even over a loose existing file
- Skills and scaffolds updated for the single framework package and the required server minimum

## [0.1.41] - 2026-10-30

### Changed

- The mutation gate redacts tool arguments (credential-named keys, declared secrets, scrub patterns) before its audit line is written

## [0.1.40] - 2026-10-30

### Changed

- Shared MCP helpers (query gate, two-step mutation gate, secret scrubbing, hub connection) now live here for the CLI and operator MCPs
- Shared read-only track-audit rules and hub wire schemas for the public MCP

## [0.1.39] - 2026-10-28

### Changed

- Agent discovery reads the display name an agent advertises

## [0.1.38] - 2026-10-27

### Changed

- The addon skill documents the standard session-lost alert for cloud integrations

## [0.1.37] - 2026-10-27

### Added

- The published package now includes its README and CHANGELOG.

### Changed

- The camstack-addon skill explains how to write a changelog entry with changelog:add.

## [0.1.36] - 2026-10-27

### Added

- CamStack Develop: CamStack developer tooling — catalogue, scaffold, validate, and example lookup shared by the CLI and MCP server.
