---
id: D391
title: A track that never emitted is a dropped detection, and reports as one
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker/**
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/frame-processor.ts
---

> **Partially superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** The `merged-duplicate` branch named below —
> `resolveDuplicates` deleting a live track — has no equivalent in tracker
> v2: an ambiguous pairing always ENDS and splits rather than merging, so
> that refusal reason and the mechanism behind it are retired
> (`scripts/check-no-legacy-tracker.ts` keeps `resolveDuplicates` out). The
> rest of this record — a track that dies before `minHits` reports as a
> dropped detection, not silence — still holds.

## Context

Camera 101, 2026-09-07 18:29:16–22. The runner's native second pass recovered
an `animal` the full-frame pass had missed on **eight consecutive frames**
(0.638, 0.810, 0.769, 0.851, 0.565, 0.740, 0.579, 0.691) and said so, once per
frame. The resulting track `68069671` stored **three** positions over 1 415 ms
and died. The last two recoveries — 0.579 at 18:29:21 and 0.691 at 18:29:22 —
produced no position, no track, no event, and **no refusal line of any reason**.

The refusal vocabulary shipped that same morning ([D377](adr-0377.md),
`spawn-refusal.ts`) already named six branches, and it was built for exactly
this investigation. None of the six fired. What made the gap invisible is that
the vocabulary described only branches that **refuse** a box. It had no name
for the branches that **accept** one and then throw the result away, and there
were three of those:

- the tracker's **emission filter** (`isConfirmedForEmit`): a spawn that dies
  before `minHits` (3) emitted nothing, ever — every box it consumed produced
  no position and no row, and the tracker's own logs said nothing because from
  inside the tracker nothing was refused;
- **`resolveDuplicates`**, which DELETES a live track on a sustained-overlap
  merge;
- the **detection-stage zone filter**, whose `filterDetections` has always
  returned what it `excluded` while the only caller destructured `{ passed }`
  and dropped the rest on the floor.

The live evidence for the first one: both tracks on 101 stop dead at the same
instant (person `862ea601` last position 18:29:19.979, animal `68069671` last
position 18:29:20.483) while the runner keeps recovering the animal for two more
seconds; the animal track was still ALIVE and coasting (`maxMissedMs` 4 000 —
`track lost` fires only at 18:29:24), so a match would have appended a position;
every instrumented refusal reports its first ten occurrences unconditionally and
the window's counters stood at 1 and 2; the camera has **no** detection-stage
zone rules (`zoneRules.listRules {stage:"detection"}` → `[]`), so the zone
filter cannot be it; and the frames were reaching the processor throughout —
the detail dispatcher fetched a crop at 18:29:23 against a handle 257 ms old.
What is left is a box that went to the spawn path, minted a fresh id, reached
`hits: 2` against a `minHits` of 3, and vanished with the subject.

The `native crop miss {reason=worker-lease-gone}` on the same camera at
18:29:23 is a real fault and a red herring for this one: it belongs to the
detail dispatch for the PERSON track, it fires after the last recovery, and
nothing on the detection→position path consults media at all.

## Decision

**Every branch between "a detection arrived at pipeline-analytics" and "a
position was stored" reports its terminal disposal through one vocabulary
(`SpawnRefusalReason`) and one log line, with `tags: { deviceId }`.** A branch
that CONSUMES a detection and produces nothing downstream reports it exactly
like a branch that refuses one — the operator's question is "where did my
subject go", and it does not care whether the answer was a refusal or an
acceptance that came to nothing. Three reasons are added: `zone-filtered`
(excluded before the tracker), `merged-duplicate` (a live track deleted by
`resolveDuplicates`), and `unconfirmed-spawn-lost` (a track that died having
never once cleared `isConfirmedForEmit`), the last reported ONCE, at the moment
the track can no longer resurrect.

The **behaviour** is left alone. Refusing to emit a track below `minHits` is
the false-positive bar working as designed; the defect was that it was
unfalsifiable, not that it was wrong. Exempting a native-measured box from it —
the D377 move — is a real candidate, and the order is: make it visible, measure
`unconfirmed-spawn-lost` per camera per hour, then decide with a number.

## Consequences

- `InternalTrack` carries `emitted` / `lossReported`. `emitted` is set in the
  one place a track becomes visible outside `sort-tracker.ts` — the emission
  `map` — so the flag cannot drift from the definition.
- A loss is reported where the track is provably final: the two
  `resurrectable: false` retirements, and the graveyard prune past
  `resurrectionWindowMs`. Never at the coast-drop, because a graveyarded track
  may still resurrect and a line about work that was not lost is worse than no
  line.
- The addon's line changed suffix, from `— no track was born from it` to
  `— nothing downstream received it`: a merged duplicate had a track and still
  produced nothing. The grep prefix `tracker: detection dropped` is unchanged.
- Cost: `unconfirmed-spawn-lost` fires on ordinary detector noise too — that is
  its point, and the sampler (first 10 per reason, then every 10th) bounds it.
  A camera whose count is dominated by this reason has either a `minHits` that
  is too high for its frame rate or a detector that flickers; both are now
  answerable from the log instead of from a hypothesis.

## Enforcement

Tests, not a guard: `sort-tracker-silent-drops.spec.ts` pins that a sub-`minHits`
track reports once when it dies, that an emitted track reports never, and that a
merge names both ids; `frame-processor.spec.ts` pins the zone-filter report. All
three were verified to fail before the change. A guard cannot see this class —
"a branch that drops work in silence" is not a syntactic property — so the rule
lives in CLAUDE.md and in the vocabulary's own docblock, which is the thing a
future author of a new drop branch actually reads.
