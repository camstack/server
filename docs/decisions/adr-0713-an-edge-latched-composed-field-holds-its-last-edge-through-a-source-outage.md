---
id: D713
title: An edge-latched composed field holds its last edge through a source outage; availability is the field's state, not its value
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/system/src/builtins/composer/composition-evaluation.ts
  - packages/types/src/composition/evaluate-field.ts
---

## Context

Camera 101's composed doorbell (D670, D671) reads Home Assistant's
`switch.doorbell_bussano`. On 2026-10-04 19:22:46 and 2026-10-06 08:10:56 the HA
provider was redeployed; its `switch` cap unregistered, and the composer logged

```
composed field doorbell.lastPressedAt: fresh → unavailable … the provider unregistered switch
```

`lastPressedAt` is an ADDED nullable field, so its unavailability policy is
`null` (D663 S1), and the composer wrote `lastPressedAt: null` over the
restored stamp. The slice changed, then changed back when the provider
returned, and post-analysis let the first change through as a press: the
operator got a doorbell notification on every HA restart. Post-analysis has
since been taught that only an ADVANCE of the stamp is a press
(`sensor-transition-gate.ts` `observeAdvance`), but the slice was still being
destroyed: every other reader of `doorbell` saw the last press vanish and come
back. D670 had listed this as an accepted exception ("writes `null` over the
restored value, which stays `null` until the next press").

The first attempt keyed the hold on the CAP: `doorbell` is
`durability: 'restored'`, so its fields are "the previous observation". It is
the wrong key. `battery` is `restored` too, and a composed
`battery.percentage = level` held at 15 % through a dead source is exactly the
stale number D393 forbids; the feeder acceptance test (`battery_status gone
writes percentage null`) said so at once.

## Decision

**A composed field whose expression is latched by `rose` keeps its last value
when a source stops answering.** `rose` returns its current output whenever no
edge happened, so its value is the last edge — history, not a reading of now —
in the same sense the `count` accumulator already held its value (D670). The
outage is reported where availability belongs, on the FIELD: the outcome is
`stale`, `held: true`, with the source's reason, and the transition is logged
`fresh → stale`. The value, and so the slice, does not change, and a recovery
with the same stamp is no change either: no write, no `DeviceStateChanged`, no
event (the event high-water only moves on a strict advance).

Bounds:

- only the policies that would otherwise WRITE a stand-in (`null`,
  `'unknown'`). A `release` field is still handed back to its native provider
  (D663 S1b) and an `offline` one still takes its device offline;
- a GONE source (fatal) is never held — the field is unavailable and the block
  fails, as D393 requires;
- nothing known (no seed, nothing written yet) stays unavailable;
- a field computed from present readings (a measurement) is not held.

A held outcome counts as "the source was down" for `rose`'s flap protection
(D49 inverse): the first answered reading after it baselines the level, exactly
as after an `unavailable` outcome.

## Consequences

- The D670 exception is gone: a source late at boot no longer writes `null`
  over a restored `lastPressedAt`.
- A composed doorbell whose source is gone for a long time shows its last
  press, stale, with the reason on the field — not "never pressed".
- A new stateful builtin that latches its output has to be added to
  `isEdgeLatch` deliberately; until it is, its field is not held.

## Enforcement

- `composition-runtime.spec.ts` — "a source outage keeps the restored
  lastPressedAt: stale, never null, and no change on recovery" and "a GONE
  source is not held".
- `doorbell-composition.e2e.spec.ts` — "a source provider redeploy changes
  nothing on 101": the 101 sequence (press, unregister, re-register with the
  same state) leaves the slice untouched with zero state changes and one event,
  and the next press counts. Both fail with `holdLatchedValue` disabled.
- `feeder-customization.e2e.spec.ts` (contrast b) keeps a measurement unheld.
