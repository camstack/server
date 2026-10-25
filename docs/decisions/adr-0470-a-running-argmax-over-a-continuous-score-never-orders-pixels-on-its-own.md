---
id: D470
title: A running argmax over a continuous score never orders pixels on its own
status: accepted
date: 2026-09-12
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/native-frame-transport.ts
---

## Context

hub-main's `socketTopActions` showed `pipeline-analytics!pipeline-runner.getNativeCrop`
as its largest outbound action all day. Three consecutive 60 s samples on
2026-09-12 (09:59–10:12, ordinary daytime load, 39 socket peers):

```
126 651 kB / 135 calls   →   938 kB per call
131 040 kB / 135 calls   →   970 kB per call
 85 725 kB /  98 calls   →   875 kB per call
```

The addon's own `native-crop window` line, over 24 consecutive minutes
(09:47:21 → 10:11:19, 34 windows), reported **314 wire fetches — 13/min** —
with `coalesced=0 reusedInWindow=0` in **every single window**.

Those two numbers describe different populations, and that was the whole
finding. `native-crop window`'s `wireFetches` is drained from `NativeCropDedupe`,
and `NativeCropDedupe` is only ever entered from `fetchNativeCropJpeg` — the ROI
path. The full-frame fetches (`getRemoteFrame`, `getNativeFullFrameRgb`,
`getNativeKeyFrameRgb`) call `requestNativeCrop` directly and were counted
nowhere on this side. Solving for the mix — a native 4 K JPEG at `quality: 90`
is ~1.3 MB, an ROI or a 960 tile is ~0.08–0.2 MB — puts **~95–100 of the 135
calls per minute on the native full-frame rung**: 73 % of the calls and ~97 % of
the bytes, on a path with no dedupe, no counter, and no gate.

There is exactly one caller of that rung left in this addon. D422 moved the
per-track `keyFrame` onto parked frames (`getParkedTrackFrame`, measured
separately at 19–27 calls/min at ~1.5 MB), and the group shot is the one
key-frame writer D422 left on the handle path. Its gate was
`isBetterSummaryScore(candidate, best)` — a bare running argmax, advanced on the
OFFER — over `SummaryFrameScore.quality`, a **continuous** blend of confidence
.30, capped area .25, recognition .25 and placement .20. A subject walking
toward the centre of frame raises that blend on essentially every frame, so
"the maximum improved" fired tens of times per summary, each time ordering a
4096-px native full frame. Summaries seal every 10–25 s per busy camera.

`summaries/min × improvements/summary ≈ 5 × 20 ≈ 100 fetches/min` — the observed
rate.

This is not a new failure mode. The TRACK key frame hit it on 2026-08-06 (RC-1:
"re-shot the native keyFrame 13 times for one track") and fixed it with a peak
signal carrying hysteresis 0.05 and a 2 s min gap, written down in
`key-frame-retry.ts`. The summary path, added later, got neither bound.

Two things were tried first and were wrong. Coalescing was the obvious answer
and is already there — `NativeCropDedupe`, whose docblock claims the ROI traffic
is "81 % of hub-main's outbound bytes". It has never fired: the keys are
`(shmId#slot#seq, region, maxWidth)` and every consumer cuts a different window
out of a frame that exists once, so `coalesced` and `reused` are structurally 0.
It is not broken; it is guarding the 3 % of bytes that were never the problem.
And D462 halved the per-call bytes the night before, which was real and left the
call count untouched.

A second defect fell out of the same read: `best` advanced when the fetch was
ORDERED. A summary whose first attempt missed kept a phantom high-water mark, so
`group shot native miss — the previous shot stands` was a lie — there was no
previous shot, and nothing lower-scoring could ever replace it.

## Decision

A running argmax over a continuous score is a candidate signal, never a
materialisation order. Pixels are fetched only when the candidate beats **what
was actually DELIVERED** (D400), by a stated hysteresis on the continuous term,
and never closer together than a stated minimum gap measured in FRAME time.
Only a landing advances the baseline the next candidate must beat; a fetch that
missed is retried until it lands, under a bound (D58).

For the group shot that is `SUMMARY_GROUP_SHOT_MIN_GAP_MS` 2 000,
`SUMMARY_GROUP_SHOT_QUALITY_MARGIN` 0.05 and
`SUMMARY_GROUP_SHOT_MAX_UNLANDED_ATTEMPTS` 4 — the same numbers
`key-frame-retry.ts` already carries, because it is the same rule one owner kind
over. `compareSummaryScores` stays the ONE ordering (D400): this is a gate over
it, the way `decideKeyFrameCapture` is a gate over `isNewBest`, not a second
ranker.

And every `getNativeCrop` this addon issues is counted by payload class, in the
window line, whether or not it passes through a dedupe. A rung that carries 97 %
of the bytes may not be the rung with no counter on it.

## Consequences

A summary's stored group shot may no longer be the exact global argmax frame: it
is the best frame among those the gate let through, which is what was on disk
anyway (D400 — ranked on what is DELIVERED). A member entering the shot still
needs no quality margin, only the gap, so the "everyone visible" property the
score exists for is preserved.

`isBetterSummaryScore` is deleted rather than left beside the gate. A helper
that describes the superseded design reads as verification.

The unlanded path is deliberately NOT peak-gated (D58): a missed group shot is
retried on a lower-scoring frame, four times, because a summary with no picture
is worse than a summary with a mediocre one.

The gate is process-global state in `GroupShotTracker`, keyed by summary id and
dropped on seal, so it bounds with the open-summary set and not with time.

## Enforcement

- `summary/__tests__/group-shot.spec.ts` — the storm test asserts that 2 s of
  10 fps frames with a monotonically rising quality produce exactly ONE
  materialisation. Neutering `SUMMARY_GROUP_SHOT_MIN_GAP_MS` and
  `SUMMARY_GROUP_SHOT_QUALITY_MARGIN` to 0 fails 4 tests, checked.
- `summary/__tests__/summary-wiring.spec.ts` — structural: `noteLanded` sits
  INSIDE the `'landed'` branch, and `logGroupShotWindow` is called on every
  offer.
- The `group shot window` and `native-crop window` lines are the field check:
  `materialised` vs `suppressedByGap`/`suppressedByMargin`, and
  `nativeFullFrameCalls` vs `roiCalls` vs `tileFullFrameCalls`. If
  `nativeFullFrameCalls` does not fall to ~10–20/min after this ships, the
  arithmetic above is wrong and the real caller is elsewhere.
- Nothing prevents the next continuous-score argmax from ordering pixels. Review
  only.

> **Since [D680](adr-0680-nearby-track-grouping-is-deleted-with-its-tables-and-its-cap-surface.md)
> this rule has no production instance:** the group shot, its only one, is
> deleted along with `GroupShotTracker` and the two specs above. The rule stands
> for the next continuous-score argmax; the payload-class counters in
> `native-frame-transport.ts` remain, and `nativeFullFrameCalls` should now read 0.
