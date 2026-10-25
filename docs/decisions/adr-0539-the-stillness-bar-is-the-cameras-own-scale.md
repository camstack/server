---
id: D539
title: A camera's stillness bar is measured in ITS subjects' own travel, and calibrated from what it has seen
status: accepted
date: 2026-09-19
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker/stillness-scale.ts
  - packages/addon-post-analysis/src/pipeline-analytics/stillness-settings.ts
---

## Context

"Is this subject still?" was decided by `velocityThreshold = 2` — two pixels per
tracker update, the same on every camera of the fleet, and not even settable.
Measured on this hub (60 recent tracks per camera, per-sample centroid speed):

```
device   px/s p50   px/s p90      diagonals/s p50   p90
592        23.4      265.5           0.0136       0.1367
101       212.1      741.0           0.3081       1.0088
102        12.1      187.7           0.0201       0.3098
618        75.7      568.5           0.0611       0.4132
```

An 18× spread in raw pixels. A doorway two metres away and a thirty-metre
driveway cannot share a pixel threshold, and the flat one gets it backwards:
2 px per update is ≈14.8 px/s at the measured cadence, which is 0.0075
diagonals/s on 592 and 0.023 on 101 — the doorway judged loosely and the
driveway tightly, the wrong way round on both.

Normalising by the subject's own box — which the SPAN half of the same
judgement already does, and why that half needs no dial — narrows it to 23×.
Still not one number. The camera's own distribution is the only honest source.

## Decision

The speed half of `settled` is a per-camera bar expressed as a fraction of the
SUBJECT'S own box diagonal per SECOND — subject-relative to divide out
perspective, per-second because an `armed:on-motion` cadence swings from 56 ms
to 2135 ms between positions (D399) and an irregular cadence must not read as
speed. An absent bar is absent: the analyzer runs the original absolute line
verbatim, so a camera nobody has calibrated behaves exactly as it did.

The bar is CALIBRATED from that camera's own tracks — p25 of its measured
speeds, clamped into `[p90 × 0.02, p90 × 0.25]`, both rails expressed against
the same camera's travel so no foreign absolute number enters. Calibration
REFUSES by name rather than inventing a bar (`no-tracks`, `too-few-tracks`,
`too-few-samples`, `no-motion-evidence`), writes what it measured and which rail
moved it onto the camera where an operator can read it, and never writes on a
refusal. An operator's pinned number and a calibration are the same write, so a
pin always wins.

## Consequences

- Run against the fleet's own data the bars span 55× — 592 at 0.0027 (p25 was
  exactly 0, the floor lifted it), 101 at 0.1475 (no clamp), 102 at 0.0062
  (floor), 108 at 0.0105. The camera whose subjects only ever transit gets by
  far the loosest bar, which is the point.
- The floor exists because a camera full of parked subjects has a p25 of zero,
  and a bar of zero means nothing is ever still. The ceiling exists because a
  camera where nothing ever parks has a p25 that IS a walking pace.
- The rails are defensible, not derived: nobody has told the system which
  tracks were actually still. The readout prints the raw quantile and the rail
  that moved it, so the argument can be had per camera instead of in the
  abstract.
- `trackIsStill`'s frame-diagonal fractions stay fleet-flat ON PURPOSE. They are
  a net displacement over a 30 s window, not a speed, and jitter does not
  accumulate as speed × time — deriving them from this bar put 101 eighteen
  times over its rail, which would have stopped every session hold on that
  camera. Calibrating them needs a different statistic and its own pass.
- `short-motionless.ts` (40 px / 8 px, per CLASS rather than per camera) has the
  same defect and is left: it decides only whether a short track is hidden from
  the Events feed, so it is cosmetic rather than a gate on work.

## Enforcement

`stillness-scale.spec.ts` pins the sampling, every refusal and both rails;
`state-analyzer-calibrated-speed.spec.ts` pins that an uncalibrated camera is
byte-for-byte today's behaviour and that a calibrated one never falls back to
the absolute bar; `stillness-settings.spec.ts` pins that a stored `0`, a reset
and an unset key are all "uncalibrated". Review-only for new thresholds.
