---
id: D626
title: A parameter carried by two channels is read from the STATUS one, and the set comes from the library
status: accepted
date: 2026-09-24
supersedes:
applies-to:
  - packages/addon-provider-homematic/src/devices/hm-child-device.ts
  - packages/addon-provider-homematic/src/homematic-decode.ts
---

## Context

An HmIP roller shutter splits itself across two channels, and the difference is
not cosmetic. Measured on the live CCU, HmIP-BROLL `00111BE992A8E5`:

    :3 SHUTTER_TRANSMITTER       LEVEL 0.475  R-E   ← where the cover IS
    :4 SHUTTER_VIRTUAL_RECEIVER  LEVEL 1.0    RWE   ← where you COMMAND it

The transmitter is the actuator reporting itself and refuses writes; the virtual
receivers are link/group targets holding the last commanded extreme. The device
was bound to the receiver alone, so the viewer showed 0 or 100 and nothing
between — and was simply wrong whenever the shutter rested part-way: **100 %
against a slat at 47.5 %**, while Home Assistant, reading the transmitter,
showed 47 at that same moment.

Three attempts, and the first two are the record:

1. **Sampling the wrong channel.** The first measurement polled `:4` for 45 s
   across a full open/close and concluded that "HmIP reports no intermediate
   position — 0/100 is all the device gives". That conclusion was about the
   CHANNEL, not the device, and it was stated as a property of the hardware.
2. **Widening the event filter.** Once the library resolved the transmitter,
   the child still dropped its events: `ownsEventChannel` accepted only the
   command channel. Widening it to accept both made the reading WORSE-looking,
   because `LEVEL` exists on BOTH channels and the last arrival won — the
   receiver's commanded extreme overwriting the transmitter's real position.
   The deploy that should have fixed it changed nothing visible.

Only the third attempt holds: accept both channels AND say which one wins per
parameter.

## Decision

A child device accepts a value event from **every channel its entity reads**,
and for a parameter available on a STATUS channel it takes the value **only
from there**. Both sets come from the library
(`HmCustomEntity.channels` / `.statusChannels`, nodehomematic ≥ 0.4.4), never
from an offset re-spelled in the provider: the channel topology is the
library's knowledge and a second copy is how two layers start disagreeing about
one device.

The seed path applies the same preference. Seeding the command channel only is
why a restart showed the last commanded extreme until somebody moved the cover.

When the entity cannot be resolved, the filter falls back to the command
channel alone. That is the safe direction: a narrower filter costs a report,
where a wider one lets an HmIP-BS2's second relay write the first one's slice —
the defect the filter exists to prevent.

## Consequences

The provider depends on the library naming its channels. A device family whose
entity does not declare them keeps the old single-channel behaviour, which is
correct for everything without a split.

The audit that came with this found the same TRANSMITTER/VIRTUAL_RECEIVER shape
on every HmIP family — switches, dimmers, wall thermostats. Measured on five
live relays the two channels agree, because a relay is instantaneous, so the
misalignment is invisible there and was deliberately NOT changed on a symmetry
argument. The dimmer is the one to watch: its LEVEL ramps like a cover's, and
there is no such device on this CCU to prove it on.

## Enforcement

`cover-channel-split.test.ts` in the library pins the split end to end through
the real `buildCustomEntities`, including that `subscribe` wakes on a
transmitter change and that `statusChannels` names the transmitter alone.
Provider-side the preference is review-only today: the fakes in
`packages/addon-provider-homematic/src/__tests__` declare `statusChannels: []`,
so no test exercises a two-channel child. That gap is worth closing the next
time this file is opened — it is exactly the shape that produced attempt 2.
