---
id: D504
title: A census sample testifies to a presence, never to an absence
status: proposed
date: 2026-09-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/occupancy-watcher.ts
  - packages/addon-post-analysis/src/pipeline-analytics/zone-analytics-provider.ts
---

## Context

Zone occupancy is fed by two producers through one tap. `recordFrame` emits a
snapshot built from a frame that went through the detector. And
`ZoneAnalyticsProvider.appendBaselineSamples` emits one every 60 s built from
the STATIONARY CENSUS ALONE, so that a detached-but-occupied camera keeps its
occupancy confirmed instead of ageing out between motion sessions.

`OccupancyWatcher` could not tell them apart. It is a pure debounce over
`count >= threshold` and had no notion of who produced a sample.

Measured on device 102, zone "Parking pat'", 2026-09-15: three false
"Pat è andato via" in twelve minutes on a car that never moved — 17:23:15,
17:30:51, 17:35:15 — two of them contradicted by a "Pat è tornato" 46 s and
30 s later. Of five departures announced in 24 h, two were false.

Who armed them is in the timestamps: `observedAt` 1789485735544 /
1789486215545 / 1789486455546, exactly 420 000 and 240 000 ms apart, all on
`:15.545`. One `setInterval` — the census sampler. The car is not censused and
cannot be: its box is ~35 % of the frame and the birth bar (D497) is 30 %. So
the census read "0 vehicles in this zone", the zone believed it, and the next
tick 60 s later — well past `sustainSeconds: 29` — confirmed it.

The first hypothesis was wrong and is worth recording: the detector was blamed,
because the same car takes five track ids in minutes. That churn is real (D497
rejects the birth every ~2 min and the track is torn down anyway) but it never
committed an edge — every live zero was cancelled by the resurrected track
within 1-4 s. The false edges came from reads in which NO DETECTOR LOOKED. Not
"two blind reads agreeing": two reads where nobody read.

## Decision

A snapshot declares its evidence: `scene` (a frame went through the detector)
or `census` (built from the stationary census alone). A `census` sample may
CONFIRM an occupancy — it may seed a level and it may cancel a pending
departure — and it may do nothing else. A `census` sample whose count is below
the threshold is dropped before it can establish a level or move one towards
empty.

The reason is D393. A census entry retires only on a FRAME: on observed
strikes (D279) or on observed time (D501). A census answering `0` is therefore
not saying "the spot is empty"; it is saying "nothing here is censused". That
is `null`, and folding it into `0` told the watcher a car had left.

## Consequences

- A real departure is untouched. A camera that just watched a car drive away
  produces SCENE samples, and on an on-motion camera those sessions run ~2 min
  — far longer than the 29 s sustain. The fix removes only the samples that
  could never have witnessed a departure.
- The sampler keeps the job it was written for: a detached-but-occupied camera
  whose car IS censused still has its occupancy confirmed every 60 s.
- A cold key is no longer seeded by an empty census, because a level must come
  from an observation. Seeding `0` there made the first real frame read as an
  arrival that never happened.
- `occupancy edge committed` now carries `committedBy`. Without it the only way
  to see this defect was to notice that every `observedAt` shared one tick.

## Enforcement

`occupancy-census-cannot-witness-absence.spec.ts` (8 tests). Five pin the rule
— including the measured two-tick sequence and, as the control, a real
scene-witnessed departure that must still commit. Three pin the WIRING, because
mislabelling the two producers type-checks, compiles and keeps firing false
departures in silence. Verified by removing each half: the rule gate red 2 of 5,
the sampler's label red 2 of 3.

Left standing, separately: `birthStationaryFromEvidence` tears the track down
even when `isPlausibleStationaryBirthBox` refuses it, so an oversize parked car
loses its track every ~2 min and the evidence ledger restarts from zero. That
is the churn, and it is a different record.
