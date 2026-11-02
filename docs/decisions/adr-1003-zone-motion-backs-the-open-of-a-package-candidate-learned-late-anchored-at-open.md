---
id: D1003
title: Zone motion backs the open of a package candidate, learned late but anchored at the open
status: accepted
date: 2026-11-02
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-zone-activity.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-stillness-tracker.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
---

## Context

D205 requires a deliverer: a non-package L1 track in a drop-off zone before the
candidate opens, fixed at open. On camera 615 the courier never became an L1
track, so even with D1002 opening the candidate from the model box it would
expire `no-activity-before-open`.

## Decision

Amends D205 and D1002. Analyzer motion with a person-sized region (under 0.8
of the frame) that reaches the package zone dilated by 0.5 is stamped per
device (`lastPackageZoneMotionAt`) and passed to the tracker as
`lastDelivererMotionAt`. It backs the OPEN of a candidate like a track does, and
an unbacked candidate is also backed late when that stamp lies between
`firstSeenAt - window` and `firstSeenAt + roundGapMs`: the backing is learned
late but anchored at the open, so a passer-by arriving later never validates
scenery. Zone motion is never a pick-up witness, never feeds the early pick-up
rule, and is never written into `lastNonPackageActivityAt`. Onboard motion, with
no regions or dimensions, never stamps. Unknown zone geometry stamps nothing.

## Consequences

An untracked courier delivers. The light-wedge loop stays closed: a wedge has no
person-sized motion near the mat, and a whole-frame change is rejected by size.
The constants are not settings.

## Enforcement

Specs in `package-zone-activity.spec.ts` and `package-stillness-tracker.spec.ts`.
