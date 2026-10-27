# @camstack/addon-provider-esphome

ESPHome device-provider addon for CamStack. It speaks the board's native API (Noise-encrypted or plain) with `esphome-client` and turns a board into one container device with a child per entity.

## What it does

- **ESPHome** (`provider-esphome`): one broker per board (host, port 6053, encryption key, optional legacy password), a LAN scan that proposes boards, and adoption of a connected board.
  - Node placement: `hub-only`.
  - Capabilities: `device-provider`, `broker`, `device-adoption`.

## Mapping

A board is one container device. Its entities become children:

| ESPHome entity | CamStack child |
| --- | --- |
| switch | switch |
| light | switch + brightness (colour is not mapped yet) |
| cover | cover (open, close, stop, position) |
| button | button |
| number, select | control |
| event | event emitter (a replayed state never fires) |
| sensor | numeric sensor, converted to the base unit of its quantity |
| text sensor | enum sensor |
| binary sensor | contact (door, window, opening, garage door), flood (moisture), smoke, motion (motion, occupancy, presence), otherwise binary |
| power, energy, voltage, current, apparent power, power factor sensors | one `power-meter` child |

Entities the board marks diagnostic or disabled by default, and its status binary sensor, are not adopted.

## Behaviour

- Live state arrives by subscription; there is no polling.
- A lost connection is retried with a bounded backoff (1 s doubling to 60 s, with jitter). A key or password the board refuses is not retried: the broker shows `auth-failed` until the operator edits it.
- An unreachable board is offline, never zero: its children keep the last reading and the container goes offline.
- The encryption key and the legacy password are keychain secrets. They are never returned by a read, never logged, and a save that leaves the field empty keeps the stored value.
- The addon only reads state and sends the commands an operator triggers on an adopted device. It never guesses or tries keys.

## Where to find the key

In the board's ESPHome YAML under `api: encryption: key:`. In the ESPHome dashboard open the device and choose Edit; in Home Assistant it is stored in the ESPHome integration entry for that device. Paste it into the broker dialog's "Encryption key" field.

## Known limits

- Light colour and colour temperature are not mapped.
- Entities of an ESPHome sub-device (firmware 2025.7 and later) are not separated from the board's own.
- Firmware older than 2024.4 is untested.
- A board allows only a few simultaneous API clients (ESP8266 especially); Home Assistant holds one of them.
- Two controllers can write the same relay; CamStack follows the state the board reports.

## Requirements

- Peer packages already on the node: `@camstack/types`, `zod`.
- A CamStack hub. This addon does not run on an agent.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-esphome` on npm.

## What it provides

- **ESPHome** (`provider-esphome`): Connect to an ESPHome board over its native API and adopt its switches, lights, covers, buttons, sensors, numbers and selects. Category: providers.
  - Capabilities: `device-provider`, `broker`, `device-adoption`.

## Requirements

- Placement: hub-only.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
