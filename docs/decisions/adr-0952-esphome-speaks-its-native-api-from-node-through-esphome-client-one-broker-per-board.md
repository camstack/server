---
id: D952
title: ESPHome is spoken from Node through esphome-client, one broker per board, with no Python worker
status: accepted
date: 2026-10-27
applies-to:
  - packages/addon-provider-esphome/**
---

## Context

The operator runs about two dozen ESPHome boards (relays, shutter controllers,
metering plugs, RF transmitters). Home Assistant already reaches them, so the
question was whether CamStack should speak the ESPHome native API itself, and
with which client: `esphome-client` (npm, ISC, zero runtime dependencies) or a
Python worker around the reference `aioesphomeapi`, run the way the Echo speech
worker was (line-delimited JSON, bounded respawn, secrets by a 0600 file).

The README of `esphome-client` says it needs a device on ESPHome 2025.10 or
later. The fleet is older (2022.9 to 2025.10, most on 2024.4 and 2024.12). A
Python worker would have been the safe answer to that sentence, so the sentence
was tested instead of believed. The spike was read-only on the LAN: an mDNS
browse of `_esphomelib._tcp`, and a connect with no key against boards that do
not require encryption (list entities, subscribe states, disconnect). No key
was guessed, no command was sent.

Measured on the real LAN:

- 12 boards answered the browse: firmware 2024.4.2 (7), 2024.12.2 (2),
  2024.8.0, 2024.10.0 and 2025.4.1 (one each); 8 ESP8266 and 4 ESP32. The TXT
  record carries `version`, `platform`, `board`, `mac`, `friendly_name`; it does
  not say whether the board encrypts, so the encryption mode is learned at
  connect time, not at discovery.
- The client negotiated the API with boards on 2024.4.2, 2024.10.0 and 2025.4.1
  (API 1.10 on one of them): handshake, entity list and the initial
  state burst all completed, on both ESP8266 and ESP32. The "2025.10+" sentence
  in the README is not a floor of the code: the negotiation accepts any peer on
  API major 1 (`SUPPORTED_API_MAJORS = { min: 1, max: 1 }`), and the entity
  decoder falls back when a board predates the newer shape. Nothing older than
  2024.4 was reachable, so 2022.9 is unproven, not refuted.
- Noise (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`) is implemented on `node:crypto`
  alone, with typed `EncryptionKeyMissing/Invalid/Required` errors that are
  permanent (never retried). The Noise path itself could not be exercised
  without a key.
- A switch that is off, and a cover that is idle, arrive as a state message with
  the field ABSENT (protobuf default), not as `false` / `0`. A decoder that
  treats "absent" as "unknown" would leave a relay "unknown" forever.

## Decision

**The ESPHome provider is a TypeScript addon on `esphome-client`; no Python
worker.** One broker is one board: host, port (6053), an optional Noise key and
an optional legacy password, both `password`-typed fields held by the keychain
(never an environment variable, never logged). The addon owns the reconnect
(bounded backoff, `PermanentError` stops it and names the cause), so "offline"
is a state it controls: a board that does not answer marks its devices offline
and keeps the last reading, it never publishes `0`. Entities are decoded with
absent-means-default.

`aioesphomeapi` stays the documented fallback, to be taken only when a real
board of an older firmware fails the handshake with this client.

## Consequences

The package needs Node 22.20 or later, which the runtime already meets. One TCP
connection per board is held by the hub; an ESP8266 serves a handful of API
clients, and Home Assistant holds one, so a board at its limit refuses us with
a connection error that the registry reports as such. Two controllers can write
the same relay. The client is a single-maintainer library: its version is
pinned exactly and the decoder is hidden behind a narrow `EspLink` seam, so a
swap to a Python worker changes one file.

## Enforcement

`packages/addon-provider-esphome/src/__tests__` pins the decoding of absent
state fields, the entity-to-capability table, the reconnect schedule, and that
the key reaches the link in memory only and no log line carries it. Review for
the rest.
