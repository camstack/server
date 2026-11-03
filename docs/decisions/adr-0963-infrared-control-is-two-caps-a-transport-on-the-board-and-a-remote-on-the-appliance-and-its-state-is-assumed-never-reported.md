---
id: D963
title: Infrared control is two caps, a transport on the board and a remote on the appliance, and its state is assumed, never reported
status: accepted
date: 2026-10-28
supersedes:
applies-to:
  - packages/types/src/capabilities/ir-transmitter.cap.ts
  - packages/types/src/capabilities/remote.cap.ts
  - packages/types/src/capabilities/media-player.cap.ts
  - packages/types/src/ir/**
---

## Context

An appliance that only listens to infrared (a television, an air conditioner) is
controlled by a board that can emit pulses. Putting the code map and the emitter
into one device ties an appliance to one vendor and makes the board's service
and the appliance's command table the same thing.

The ESPHome user-services API is fire-and-forget: there is no call id and no
reply, so a send can never be confirmed. An IR appliance does not answer either.

## Decision

1. **Transport and command map are separate caps.** `ir-transmitter` is
   device-native on the BOARD side: one device per board service that takes a
   pulse train, `send({ timings, settings })` and `getInfo`. `remote` is the
   per-appliance command map (D964); it never knows the vendor and reaches a
   transmitter only through an Action-shaped binding over `ctx.api`.
2. **A send reports what it can know.** A transmitter that cannot confirm a
   delivery says so; a setting it cannot apply comes back in `ignoredSettings`.
   `remote.sendCommand` returns a typed result (`sent`, `skipped`, or `refused`
   with a named reason), never an exception for an expected refusal.
3. **IR state is assumed.** `MediaPlayerStatus.stateSource` is `reported |
   assumed`; every provider that reads the device reports `reported`. The remote
   moves its assumption only AFTER a send landed, and a power code that is the
   same pulse train for `on` and `off` (a toggle) is sent only when the current
   state differs from the requested one. The current state is read from the
   `running-state` cap when the device has one, else from a native media-player
   reading, else from the assumption. An assumption is persisted in the device
   store, never in history, and a UI must show it as a guess.
4. **The SmartIR parser is single.** `parseSmartIr` in `@camstack/types/ir`
   reads a file (Raw and Pronto); the remote only turns its result into bindings
   (`smartIrDraft`). The admin UI runs both and saves the result on the cap; the
   server never receives a code file.

## Consequences

A UI cannot present an assumed state as a reading: it must read `stateSource`.
There is no vendor-specific code in the remote.

## Amendment (planning#398): power of a media player powered by a switch

For a media player composed with a `power-source` (a television behind a smart
plug), the plug is the only READING of its power. The remote's status rule:

- plug off: `off`, `stateSource: 'reported'` (a plug cut is a fact, not a guess);
- plug on: `standby`, `stateSource: 'assumed'`, until the remote sends a power
  command, then the power the remote last sent (still `assumed`);
- plug off also forgets the remote's assumed power, so the next plug-on starts
  from `standby`; plug on drops an assumed `off` (the plug contradicts it);
- plug unknown (`null`): nothing is claimed from the plug (D393); the remote's
  own assumption, if any, is all there is.

A `running-state` reading, when the device has one, still wins over both. A
native media-player reading that is `reported` is never overridden. The
composition side of this (the composed native and its fields) is the D967
amendment; the dispatch-to-transmitter chain for step commands is covered end to
end by `remote-alexa-chain.spec.ts`.

## Enforcement

Specs: `remote-service.spec.ts`, `smartir-draft.spec.ts`, `ir.spec.ts`, `remote-alexa-chain.spec.ts`.
`check-method-tiers` and `check-export-coverage` cover the cap methods.
