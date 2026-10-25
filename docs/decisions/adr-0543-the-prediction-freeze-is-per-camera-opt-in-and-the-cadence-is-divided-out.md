---
id: D543
title: The prediction freeze is per-camera opt-in, and the cadence is divided out
status: accepted
date: 2026-09-19
supersedes:
---

> **Superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** The prediction freeze (`pipeline/tracker/stationary-freeze.ts`)
> is deleted with the old tracker: L1 carries no stillness state at all. A
> still subject belongs to the parked-object registry (D547), which is now
> the only stillness authority — not a frozen prediction on a live track.

## Context

`SortTracker.predicted` freezes a track's predicted box — so bbox jitter cannot
walk it off a sitting object — when

```ts
hypot(velocity.dx, velocity.dy) * emitIntervalMs < stationarySpeedPx
```

`velocity` is px per millisecond and `emitIntervalMs` is this camera's
reporting cadence, so the setting is calibrated in **pixels per however often
this camera happens to report**. That interval is not a constant. D399 measured
**56 ms to 2135 ms** between stored positions on a SINGLE subject of this fleet,
so the shipped default of `2` means

```
2 px / 56 ms   = 35.7 px/s
2 px / 2135 ms =  0.94 px/s
```

a **38×** spread from the cadence alone — and that sits on top of the **18×**
spread in raw px/s ACROSS the cameras of this hub that `stillness-scale.ts`
measured on 2026-09-19. One number cannot be all of those.

D539 fixed the *operator-facing* stillness question this way (a per-camera bar
in subject-diagonals per second). A session note listed this threshold as "the
same rule in another place". Tracing it says otherwise, and the distinction
matters: `StateAnalyzer.velocityThreshold` answers "is this subject stationary",
is reported to the operator, and is already per-camera; `stationarySpeedPx`
answers "should I stop extrapolating this box" and is internal damping. Same
units defect, two different decisions — they must not be merged into one knob.

The rejected alternative was to normalise unconditionally: express the bar in
diagonals per second for every camera and be done. That silently re-tunes
tracking on a live fleet, on cameras nobody has measured, to a number derived
from a different question. D394 already settled the shape for exactly this
situation.

## Decision

The freeze bar is **per-camera opt-in, and the default is what shipped**.

- `stationarySpeedPx > 0` — the legacy px-per-report rule, byte for byte.
- `stationarySpeedPx === 0` — this camera is judged on its CALIBRATED bar
  (`stillSpeedFracPerSec`, box diagonals per second): the cadence is divided out
  by measuring per second, and perspective by measuring against the subject's
  own box.

Opting in is not a licence to invent a number. With no calibration, or no box
to measure against, the shipped default decides — a camera's behaviour changes
only when a measurement exists to change it. A non-positive calibrated bar and
a non-positive diagonal both count as "no measurement", never as "infinitely
still" (D393).

The decision lives in ONE pure function, `shouldFreezePrediction`, so it can be
held against the numbers that motivated it.

## Consequences

- Nothing on the fleet changes until an operator sets a camera's `stationarySpeedPx`
  to 0, and then only if that camera has been calibrated.
- The tracker now carries `stillSpeedFracPerSec` alongside the analyzer's copy.
  It is spread conditionally in both places: absent means "not calibrated", and
  an explicit `undefined` key would say so only by accident.
- The two stillness questions stay separate. Anyone tempted to collapse them
  into one setting should read the Context first.
- `trackIsStill`'s frame-diagonal fractions are still a NET DISPLACEMENT over
  30 s, not a speed, and are still flat. They are NOT covered here — deriving
  them from a speed bar put one camera 18× over its rail once already.

## Enforcement

`pipeline/tracker/__tests__/stationary-freeze.spec.ts`. One test deliberately
PINS the cadence defect on the legacy path (the same subject freezes at 56 ms
and coasts at 2135 ms), so a future unconditional normalisation cannot slip in
unnoticed. Removing the calibrated branch fails exactly the two tests that
assert the new behaviour and no others — checked, not assumed.
