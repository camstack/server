# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.193] - 2026-11-11

### Changed

- Rebuilt against updated dependencies.

## [1.2.192] - 2026-11-08

### Changed

- Infrared-code remote sources are offered as Alexa input sources.

## [1.2.191] - 2026-11-08

### Changed

- Alexa channel changes by number or name for a remote's declared channels; inputs only for declared input sources

## [1.2.190] - 2026-11-08

### Changed

- Its integration-instances provider declares its instance kind and stamps it on every instance.

## [1.2.189] - 2026-11-08

### Changed

- Rebuilt against updated dependencies.

## [1.2.188] - 2026-11-07

### Changed

- Internal: its stored state is now read and written through the typed state API under the same storage key; nothing changes for the operator.

## [1.2.187] - 2026-11-07

### Changed

- Rebuilt against updated dependencies.

## [1.2.186] - 2026-11-06

### Changed

- Rebuilt against updated dependencies.

## [1.2.185] - 2026-11-06

### Changed

- Reads the instance switch through the shared isInstanceEnabled helper; behaviour unchanged

## [1.2.184] - 2026-11-05

### Changed

- The Alexa skill's ingress token and push state now live in a per-skill record; the existing token and link keep working without relinking
- Alexa export: run several Alexa skills from one hub, each with its own account links, exposed devices and ingress token (skill-scoped URLs, optional HUB_INSTANCE_ID in the skill Lambda; the first skill keeps its URLs)

## [1.2.183] - 2026-11-04

### Changed

- The devices and actions exposed to Alexa are kept in their own record instead of the addon settings; they move across on the first start and the addon refuses to start if they cannot be moved.

## [1.2.182] - 2026-11-04

### Changed

- Export calls name the export instance they address; an unknown instance is refused with export-instance-unknown

## [1.2.181] - 2026-11-03

### Changed

- Fixes the Alexa account-link migration that failed with 'tokens.find is not a function' and could delete the old link settings without a verified copy; a retry now repairs a partial link record

## [1.2.180] - 2026-11-03

### Changed

- A media player is exported to Alexa as a TV with power, step volume, mute, channel skip, playback and inputs
- The Alexa skill (mode, region, audience, feature switches) is now an integration instance, and the linked accounts and Amazon push grants moved into a record; they survive the move unchanged.

## [1.2.179] - 2026-11-02

### Changed

- The hub's public address for Alexa is now the Network page's Public endpoint (the External address picker is gone); re-link the Alexa skill once so issued tokens carry it

## [1.2.178] - 2026-11-01

### Changed

- A fan is exported to Alexa as its own device: power, speed, oscillation and presets, including the presets you author in Customize.
- A heater is exported to Alexa as a switch.

## [1.2.177] - 2026-11-01

### Changed

- Declares the minimum CamStack server it needs; the Addons page shows a held update as requires server >= X

## [1.2.176] - 2026-10-31

### Changed

- A lock reporting door-open is reported as UNLOCKED to Alexa.

## [1.2.175] - 2026-10-29

### Changed

- Actions can be exported to Alexa as scenes: saying the scene name runs the action (admin links only).

## [1.2.174] - 2026-10-29

### Changed

- Alexa shows the doorbell camera sooner after a press: the stream starts warming up when the press is posted

## [1.2.173] - 2026-10-28

### Changed

- Device value fields are named after their quantity instead of their unit; run the quantity-field migration after updating

## [1.2.172] - 2026-10-27

### Changed

- Shown as "Alexa Export".

## [1.2.171] - 2026-10-27

### Added

- Alexa Export: Alexa Smart Home Skill export — hub-side OAuth provider + directive handler. The companion AWS Lambda forwards Alexa directives to this addon's /addon/export-alexa/directive endpoint.
- Provides the addon Alexa Export.
