---
id: D275
title: Stationary suppression drops EVERY detection on a parked object, and matches its class through the macro map
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-match.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts
---

## Context

The stationary registry exists so a parked car stops re-spawning tracks. The
promotion half was recalibrated on 2026-08-28 (ratio 0.6 over a 120 s span,
`minAgreed` 8, `agreeIou` 0.5) and works: device 102 went from 1 held entry to 3,
and the three boxes are the ones the calibration said were being missed.

Suppression did not follow. Measured on the live hub over the two hours after the
promotion fix shipped, on 102: **23 tracks, and 13 of them sat on one of the
three stationary boxes at IoU ≥ 0.5**. The operator's report — "many tracks on
parked cars" — was correct against a registry that was, by then, holding the
right objects.

Three of the four candidate explanations were killed by reading the path:

- **Not the stage.** The gate runs at `frame-processor.ts:629`, before
  `this.tracker.update` at `frame-processor.ts:645`. A suppressed detection never
  reaches the tracker at all.
- **Not a second registry.** The promotion (`index.ts:10008`) and the gate
  (`index.ts:10216`) call the same `this.stationaryRegistry` instance, in the same
  process, keyed on the same device.
- **Not the IoU thresholds.** This is what the measurement settles. IoU 0.5 is
  five times the association floor (`WAKE_ASSOC_IOU` 0.1), and at that overlap the
  detection's centroid is inside the entry box, so the jitter branch holds too.
  Those 13 detections satisfied **every** geometric criterion in the matcher and
  were released to the tracker anyway. Raising or lowering a threshold could not
  have changed one of them.

What was left were two properties of the comparison itself:

1. **The matcher was entry-driven and dropped ONE detection per entry.** For each
   entry it found `bestIdx`, the single best-overlapping same-class detection,
   and added only that index to `suppressedIndices`. Every other box on the same
   parked car — the duplicate a detector routinely emits for a large vehicle, the
   partial box at night — went to the tracker and opened a track there. The
   operator's requirement is stated over detections ("la pipeline deve ignorare i
   frame che corrispondono a tipo e box delle stazionarie attuali" [the pipeline must ignore the frames that match type and box of the current stationary objects]); the code
   implemented it over entries.
2. **Class identity was a raw `!==` on the stored string.** Both sides are
   supposed to be a detection macro, and today's promotion path guarantees it
   (`frame-processor.ts:484` stamps `class: det.macroClass`). Nothing enforces it
   on the way back IN: `rowToEntry` accepts any string, and `load()` validates only
   the BOX (`stationary-registry.ts:196`). The live 102 registry carried the
   classes `vehicle`, `Car`, `vehicle` — and under a raw compare a `Car` entry can
   never be confirmed, never suppress and never wake. It is a total blind spot
   that survives until the TTL sweep collects it, which on the operator's bound is
   up to 30 minutes of observed time, flooding tracks the whole way.

## Decision

A detection that matches a live stationary entry's class and box is dropped
before the tracker, **whichever detection it is** — not only the entry's single
best match. Class identity is compared through `normaliseStationaryClass`, which
lower-cases and maps through the same `COCO_TO_MACRO` catalog the executor uses,
never as a raw string compare on either side. An entry that WOKE this frame
suppresses nothing at all, so a departure still hands its object back to the
tracker.

## Consequences

- The criterion did not change; its reach did. A second, detection-driven pass
  applies the identical `stillParked` predicate (IoU ≥ `suppressIou`, or IoU ≥
  `wakeAssocIou` with the detection centroid inside the entry box) to every
  detection the entry-driven pass left behind.
- **Only the entry-driven pass confirms.** The reach pass suppresses and reports
  nothing else, so it can never re-anchor a reference box (D174) and can never
  arm or clear a departure strike (D49). A duplicate box cannot move the anchor.
- **Over-suppression is now possible where it was not.** A moving vehicle whose
  box overlaps a parked one at IoU ≥ 0.1 with its centroid inside the parked
  rectangle loses a frame or two while it passes. The tracker coasts through that
  on `maxAge`; it used to lose those frames anyway whenever the passing car was
  the best match. Class gating is untouched, so a person in front of a parked car
  still gets a track.
> **Amended by [D410](./adr-0410-a-stationary-hold-may-continue-a-track-but-never-opens-one.md), 2026-09-09.**
> The bullet above priced over-suppression as "a frame or two … the tracker
> coasts through". Measured on device 102, where the parked cars sit at the
> frame EDGE, a car driving across their front was held on every frame until it
> left the frame and lost its track four times in one evening. A held detection
> still may never OPEN a track; a hold below `suppressIou` (swallow, jitter,
> departing) now reaches the tracker flagged continuation-only, so it can
> CONTINUE a track already confirmed and nothing else. The strong reads — the
> parked object's own box — are dropped before the tracker exactly as here.

- **The `Car` case is fixed by normalisation, not by cleaning the row.** Rows are
  not rewritten. This is deliberate: whatever wrote a non-macro class once may do
  it again, and a matcher that only works on well-formed input is the defect.
- Cost of the normalisation: `car`, `truck`, `bus`, `bicycle`, `motorcycle` and
  `boat` all resolve to `vehicle`, which is what the pipeline already does
  upstream. No two macros collapse onto each other.

## Enforcement

Tests, in
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/__tests__/stationary-match.spec.ts`:

- a named `Car`-entry group (suppresses a `vehicle` detection, still wakes, still
  refuses a person),
- the reach cases, including one at exactly the measured signature (IoU ≥ 0.5,
  below `suppressIou`, centroid inside),
- an acceptance case built from the three real 102 boxes with their real classes,
  asserting no detection on a parked box survives and the unrelated moving car
  does,
- the wake cases, including the leftover box a woken entry must NOT swallow,
- and, in `stationary-registry.spec.ts`, that 20 dropped detections produce zero
  log lines while they happen and exactly one at the sweep.

No guard script: the invariant is a predicate, not a shape, and a test asserts it
directly.
