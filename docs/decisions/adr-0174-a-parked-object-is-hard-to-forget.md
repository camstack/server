---
id: D174
title: A stationary entry follows its object and is never retired on one read
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/**
---

## Context

Since [D161](adr-0161-a-track-is-never-forgotten-only-closed.md) a promoted
track is persisted instead of vanishing, so promotions became visible for the
first time. The operator's reading of them was immediate and correct: *"le
stazionarie compaiono fin troppo — per quale ragione sono state promosse a
tracks in movimento?"* A parked object should produce ONE registry entry and
absorb its own re-detections; instead it produced a cycle.

Measured on the live hub, 24 h to 2026-08-15 12:00 (`docker logs` + the
`pipeline-analytics:tracks` table, 119 promotions, 109 with position history):

| | |
| --- | --- |
| promotions / 24 h | **119** — 107 `person` on indoor cameras, 12 `vehicle` |
| worst camera (111, sala da pranzo) | 43/24 h; 17 of them on ONE spot, cycle **237 s** |
| 618 (bedroom) | 30/24 h; 19 on one spot, cycle **222 s** |
| promoted-track life | median **30.1 s** = exactly `promotionWindowMs` |
| tracks that NEVER moved in their whole life | **38%** overall, **77%** on 618, **71%** on 102 |
| entries alive at the time of the audit | **2** |

Two numbers name the fault:

- **Median track life 30.1 s, the floor.** A re-born track is promoted at the
  earliest legal instant, i.e. it was already stationary when it was born. 38%
  of them never exceeded the static thresholds at any point in their life.
  Nothing about these objects was ever "in movimento".
- **65% of entries were retired less than 300 s after promotion.** The TTL is
  300 s of OBSERVED time, and observed time ≤ wall-clock time, so those
  retirements **cannot** be the TTL sweep. They were wakes.

The wake fires on ONE frame: a same-class box with IoU in
`[wakeAssocIou, suppressIou)` whose centroid falls outside the entry's box.
Two things made that trivially easy to trip:

1. **The entry's `bbox` was frozen at the promotion instant, forever.**
   `applyFrameOutcome` advanced `lastConfirmedAt` and nothing else, so the
   reference box never followed the object. The object's own drift accumulated
   against a fixed reference until a normal frame read as a departure. In 13% of
   the re-births the new track's first box had IoU ≥ 0.6 with the retired
   entry's box — the object had not moved at all, and a track was born anyway.
2. **The retirement was silent.** No log line, only an `EventCategory` emit. The
   operator saw a stream of promotions and had nothing that said what had ended
   the previous one; neither did this investigation, which had to bound
   wake-vs-TTL from wall-clock arithmetic instead of reading it.

The first thing tried was tightening the geometry — raising `wakeAssocIou`, or
requiring the centroid to leave by a margin. Both trade the 102 parking-lot
flood back for this one — the regression `WAKE_ASSOC_IOU` exists to prevent:
make association harder and a neighbouring car stops waking an entry, but a
departing car stops waking it too, and the entry lingers in occupancy for the
full 300 s TTL. The defect is not the threshold. It is that a single fallible
read was allowed to destroy an entry — the shape [D49](adr-0049.md) already
names.

## Decision

A stationary entry FOLLOWS its object and is never retired on one read:

- **An unambiguous confirmation (IoU ≥ `suppressIou`) re-anchors the entry's
  `bbox` to the observed box.** A weak (jitter) match still confirms the entry
  and advances its clock, but must not re-anchor it — a partial box is a bad
  anchor.
- **A departing read only ARMS the entry.** The detection stays suppressed and
  the entry survives. The entry is retired only when a SECOND read agrees —
  departing again, or missing entirely. A confirming read clears the strike.
- **Every retirement is logged**, at `info`, with `tags: { deviceId }` and a
  `reason` of `departed` or `ttl`. Suppression, which happens on every frame of
  every parked object, is counted per device and rolled up into ONE line per
  sweep — never a line per frame.

## Consequences

- A genuinely departing object spawns its moving track ONE frame later
  (~100–400 ms at inference cadence). That is the whole cost.
- The class gate is untouched, so absorption cannot go wrong in the other
  direction: a `person` crossing in front of a parked `vehicle` never touches
  the entry, is never suppressed, and gets their own track. A test asserts it.
- `StationaryConfirmation` now carries `observedBbox` and `strong`, and the
  filter result carries `armedEntryIds` / `disarmedEntryIds`. These ride
  through `FrameProcessor.process` — a frame whose only outcome is a first
  departure read has empty `confirmed` and `woken`, so `applyFrameOutcome`'s
  caller-side guard had to widen or the strike would be dropped.
- The armed set is per-device in-memory state, cleared by `forgetDevice`,
  `clearDevice` and `dropEntry`. It is deliberately NOT persisted: a respawn
  losing a half-formed departure costs one extra frame of suppression.
- **This does not fix the TTL half.** 35% of the cycles are compatible with the
  300 s TTL — an object that stops being detected on its spot. That needs
  absorption at birth (a detection matching a recently-retired entry re-instates
  it instead of spawning), which is a separate decision.
- **It does not answer whether a `person` should be promoted at all.** 90% of
  the measured promotions are people sitting still indoors, whose tracks are
  closed with no `end` key-event. The registry's own docblock scopes it to
  parked objects. That is an operator-facing semantics question, not this record.

## Enforcement

`stationary-match.spec.ts` and `stationary-registry.spec.ts` — the two-read
contract, the disarm, the re-anchor, the class gate, and a drift sequence that
escapes a frozen box but not an anchor that follows. Each was verified by
removing the fix and confirming the tests fail (6 and 2 respectively).
`frame-processor.spec.ts` asserts the arm survives the FrameProcessor.
Note that `__tests__/**` is excluded from `tsc`, so a fake gate can omit a
required field and still run — the fakes here were completed by hand.
