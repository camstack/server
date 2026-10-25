---
id: D431
title: The audio lane shows a level, and the hub computes it
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/audio-level-density.ts
last-verified: 2026-10-02
---

## Context

The operator reported that the timeline's audio pills read near maximum even
during quiet hours, and guessed the cause: "forse ora mostra il max che è
fuorviante" [maybe now it shows the max, which is misleading]. The truth was worse than a max-versus-mean question — **the bar
never looked at the level at all.**

`densityToAudioBuckets` read `EventDensityBucket.audio`, the NUMBER of audio
events in the bucket, normalised it with `log1p` against a floor of 80, and
painted the result on `audioPeakColor` — the same six-rung meter the live view
uses for dBFS. Measured:

| events in the bucket | rungs lit |
| --- | --- |
| 5 | 2/5 |
| 10 | 3/5 |
| 20 | 4/5 |
| **50** | **5/5 — maximum** |

Fifty brief clicks in a quiet hour saturated the meter whatever their volume.
It is a category error, not a scaling one, and no rescaling fixes it.

The operator's instinct about the max was also right, about a different piece
of code: a dBFS path existed in the viewer (`audioEventsToBuckets`) which took
the bucket's MAXIMUM — and it had **zero callers**. It had sat there for months
reading as though the problem were solved, which is precisely the leftover this
repo has been bitten by before.

The obstacle was real: the hub exposes dBFS only per audio EVENT
(`getAudioEvents`), not as a continuous series. Fetching those in the viewer
means thousands of events per camera on a 24 h tape, on every timeline open.

## Decision

**The hub aggregates the level; the viewer paints it.**

`EventDensityBucket` gains an optional `audioDbfs`: the **energy-weighted mean**
dBFS of the bucket's audio events, computed in `densityByKind` where the samples
already are. One number per bucket crosses the wire instead of every event.

The mean is energy-weighted because dBFS is logarithmic: an arithmetic mean of
dB values is the mean of nothing physical and under-weights the loud moment
that is the reason to look at a bar. Averaging power and converting back is what
a meter shows, and it is the same arithmetic as an RMS over the interval. A
stored −∞ (digital silence) is a real measurement and contributes zero power;
`NaN` carries no claim and is dropped.

**A bucket with no audio event has NO level, and the lane draws nothing.**
Absent, never zero: "nothing was heard" and "nothing was measured" are different
claims, and a lane that cannot tell them apart is how a quiet hour came to be
painted at full scale. The count is explicitly NOT a fallback — that
substitution is what the defect was made of — so an older hub, or a level
aggregation that failed, yields an empty lane rather than a wrong one.

## Consequences

- The lane is ordered by loudness. A busy quiet hour reads quiet; a single door
  slam reads loud. The old rule capping a lone event below half intensity is
  gone, because it existed only to compensate for a count that could not tell a
  slam from a bird.
- The field is additive on an existing method, so only the providing addon needs
  redeploying — no closure round trip.
- The aggregation reads the window's audio events once, `slim`. A read that
  fails logs and yields an empty map: the motion and object counts beside it are
  unaffected, and the lane degrades to drawing nothing.
- `audioEventsToBuckets` in the viewer is now the only dBFS path with no caller
  left. It should go; it is kept for one release only because removing it in the
  same change would hide whether this one works.

## Follow-up: the level now comes from device-history, as a PEAK

After the LTS cutover (D850) the continuous level lives in the device-history
series `addon:pipeline-analytics/audio-level`, not in audio events (the
unclassified events that carried it are gone). `audioDbfs` keeps its name and
its rule (one level per bucket, omitted when not measured, never 0) but its
meaning is now the bucket's PEAK:

- The producer feeds every analysed sample and writes one point per 10 s window
  carrying the window's maximum, so a short spike is not averaged away and
  stable audio still yields a point per window.
- `densityByKind` reads the series once per device per call: raw tier for
  buckets under 5 min inside 7 days (and at most 5000 points), the 5m rollup
  inside 14 days, else 1h. The bucket value is the maximum of the points'
  `max` (rollups keep `max`; a rollup row can echo a held earlier peak).
- A bucket with a level is emitted even when all counts are 0.
- A failed history read, or an empty series, falls back to the audio events
  (their energy-weighted mean) and logs once per camera.
