# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A hub restart no longer unlinks the Alexa skill: a directive whose token names an address this hub still answers on is served, and a hub with no public address yet answers a temporary error.
- Connection: the public skill's beta invitation is a clickable "Enable the skill" link instead of plain text

## [1.2.205] - 2026-11-21

### Changed

- A refused Alexa push grant no longer unlinks the skill: proactive updates pause, the link is kept, and the hub re-checks the broker on a 1/2/5/15/30/60 minute backoff and resumes by itself; a rejected token now triggers an immediate broker refresh

## [1.2.204] - 2026-11-21

### Changed

- The Alexa settings explain that the public skill is a beta: request access in the GitHub discussion, then enable it from the beta invitation link

## [1.2.203] - 2026-11-19

### Changed

- An instance's on/off switch is read from the hub registry row, and moved there from the record on first boot

## [1.2.202] - 2026-11-18

### Changed

- A thermostat directive answers with the state the hub shows after the command, instead of a projection of its own.
- Alexa is told a lock or alarm state only once the device confirms it; a command still in flight is never reported as locked or disarmed.

## [1.2.201] - 2026-11-17

### Changed

- No behaviour change: a code comment names the renamed camera wake method (wakeUp)

## [1.2.200] - 2026-11-17

### Changed

- Alexa asks for a PIN and refuses a code-less arm when an alarm panel cannot tell whether it needs one.

## [1.2.199] - 2026-11-17

### Changed

- A switch that only reports its state (a PoE port seen only through an API key) is not discovered by Alexa as a power-controlled device.
- Discovery logs, with the device, a switch whose options could not be read (D1058)
- Discovery no longer warns for every plain switch whose provider has no getOptions; only a failed read warns

## [1.2.198] - 2026-11-16

### Changed

- Commands from Alexa are recorded with the linked account that asked.
- Climate, media-player, fan preset and PTZ commands from Alexa now record which linked account asked

## [1.2.197] - 2026-11-13

### Changed

- A switch with the role switch-light is discovered by Alexa as a LIGHT with power only
- A switch-fan is exported as a FAN and an outlet or fan child as SMARTPLUG / FAN; a heater or helper switch stays a SWITCH.

## [1.2.196] - 2026-11-12

### Changed

- The Alexa name is now per skill, in the shared 'Name on <skill>' field; existing Alexa names move to the default skill unchanged.

## [1.2.195] - 2026-11-12

### Changed

- Each Alexa skill on a hub only accepts accounts linked to it: the Lambda routes reach a skill at /addon/export-alexa/instances/<id>/, a link token for another skill is refused with a logged reason, and existing links keep working without re-linking

## [1.2.194] - 2026-11-11

### Changed

- Alexa shows a climate device as an air conditioner only when its role is air conditioner; every other climate device (thermostat, radiator, floor, heat-pump circuit) is a thermostat. Plug-in heaters are exported as switches.
- A custom fan preset that only partly applies names the fan-control field that failed

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
