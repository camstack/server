---
id: D535
title: Growth rescues a fragment, never a settled whole object
status: accepted
date: 2026-09-18
supersedes:
---

> **Superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** The `growth` rescue clause — exempt from the
> plausible-birth veto on the premise that a partial crop is by
> construction the same subject — has no equivalent in tracker v2: L1 never
> rebinds a box onto another tracklet's identity online. An ambiguous
> pairing always ends and splits; whether the pieces are one subject is a
> deferred linker's decision.

## Context

The operator marked a track "Oggetto stazionario": on camera 102 a box started
on a parked car, jumped to a white car entering the frame, followed it, and then
sat 34 s on a second parked car. Two `object` events were raised on a parked car
with an importance inherited from the moving one.

The jump — 1130 px, IoU 0, 137 ms after the last match, on a track 554 ms old —
can only have come from the `growth` clause: a same-class partial crop growing
into a full-body box. That clause is deliberately exempt from the
`isPlausibleBirth` veto, because "a partial crop is by construction the same
subject".

The premise is what failed. The track's box was not a partial crop of anything;
it was a whole parked car. `growthAdjacentMatch`'s own docblock proves geometry
cannot separate the two cases — in every scale-relative measure the theft is the
MILDER jump than the rescue the clause exists for — and names track MATURITY as
the only separator. Maturity did not hold either: 554 ms is well inside the
1500 ms window.

## Decision

Growth additionally requires the TRACK's own box to be a FRAGMENT: at most
`GROWTH_MAX_TRACK_FRAME_FRAC` (0.01) of the frame. A settled whole object that
"grows" into a box it barely touches is a second object, whatever its age.

The three live cases, as a fraction of their frame:

```
4285605a   bird crop 15.5x32.3 on 1920x1080   0.0002   KEEP
59dfb972   car  364x385                       ~0.07    REJECT
vjtp1nd2jy parked car ~500x500 on 3840x2160   0.030    REJECT
```

Two orders of magnitude separate the rescue from both thefts, so unlike every
geometric measure this one has room: 0.01 sits mid-gap on a log scale with ~50x
of headroom on the case the clause exists for.

## Consequences

**A close-up subject whose partial crop really does fill a tenth of the frame
re-spawns instead of keeping its id.** That is the cheap loss, and the same one
D442 accepted: a spare track costs media; a stolen track corrupts the plate, the
travelled distance and the last frame of the track it was taken from.

**The test is SKIPPED when the caller gave no frame context** (`frameArea === 0`),
exactly as the spawn-area floor is. A fraction of an unknown frame is not a
measurement, and the passes that reach this clause do not all carry a frame.

**The spawn-area floor could not be reused for this**, which is worth recording
so nobody tries: `minSpawnAreaFracVehicle` defaults to **0**, so
`meetsSpawnAreaFloor` answers `true` for every vehicle box on a default install.
It measures whether a detection deserves a track, not whether a box is a
fragment.

## Enforcement

`sort-tracker-rescue.spec.ts` pins all three live cases plus the no-frame skip.
Removing the predicate turns the `vjtp1nd2jy` case red, which was verified.
