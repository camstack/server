---
id: D397
title: A coasted frame is not a frame the subject was in, so the detail plane never asks about one
status: accepted
date: 2026-09-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/detail-dispatcher.ts
---

## Context

`native crop miss` at `servedTier=miss` is lost work: the caller is handed
`null` and an enrichment never happens.
[D379](adr-0379.md) fixed the birth gate's share of it by cutting the pixels
while the worker still held the frame, and named what it left open — "the
withdrawal race is still there for the full-frame consumers; `keyFrame` and
detail `frameJpeg` still ask by handle and still miss."

Two readings were on the table for that remainder, and the fix was held until
the hub could say which dominates.

**The write-gap reading is largely falsified.** The wait-for-in-flight-cut fix
shipped the same day works and is sane — 0 timeouts, cut latency p95 152 ms
against a 500 ms bound — but recovers only ~6% of misses, which its own author
had set as the falsification threshold.

**The hub answers the rest.** One hour of misses, aggregated on the hub
(2026-09-08, 486 lines):

| `workerReason` | lines | share |
| --- | --- | --- |
| `frame N released and no retained tile for this frame` | 383 | 78.8% |
| *(no `workerReason` — registry at `registrySize=4096 registryCap=4096`)* | 93 | 19.1% |
| `frame N released and no retained subject or scene tile contains the requested rectangle` | 10 | 2.1% |

So the second candidate shape — "tiles are cut only for some subjects, so a
later ask about a different subject finds nothing" — is the 2.1% population, not
the problem. The problem is frames for which **no tile was ever cut**.

That has one cause, and it is structural. A subject tile is cut per surviving
detection of a `FrameResult` (`tile-cut-plan.ts`), and the scene tile rides the
same call **on detection-bearing frames only** (`scene-tile.ts`: "A frame that
detected NOTHING gets nothing, scene tile included"). So a frame with zero
detections has no retained rung at all — and the only consumer that can name
such a frame is one asking about a track that frame did **not** observe.

`matchedThisFrame` is exactly that fact, and the invariant was already written
down on `TrackedDetection`: a `false` entry is media-INELIGIBLE, because
cropping a coasted box yields the empty scene. Three sibling media paths in
`pipeline-analytics/index.ts` honour it — `buildSnapshotTargets` (which gates
snapshot, lastFrame, thumbnail and the native keyFrame together),
`collectFirstFrameRetries`, and the widened raster-fallback retention loop. The
detail dispatch did not: its loop wrote `dev.tracks.set(trackId, frame)` on
every frame, so a coasted track's association was overwritten with a frozen bbox
and the CURRENT frame's handle.

Handle ages at the miss confirm the asks are not exotically late — p50 577 ms,
p75 2.3 s, p90 16.9 s, max 24.1 s against a 30 s tile TTL. A longer retention
window was measured and rejected: 71% of asks arrive within two seconds and 38%
within half a second, so a longer window buys almost nothing, and this repo's
rule is to remove the cause of allocation rather than raise the ceiling.

## Decision

A frame a track **coasted** through is never associated with that track. In
`TrackDetailDispatcher.onFrame`, a `TrackDetailFrame` carrying
`matchedThisFrame === false` refreshes nothing, observes nothing, and adopts
nothing: it does not replace the track's frame association, it does not reach
`candidateBest` (a coasted confidence is not an observation and must not fire an
`improve` dispatch), and it cannot bootstrap an unknown track — a predicted box
is not a birth. It is counted per device and reported per camera.

Absent is read as **matched**, the same `!== false` idiom the sibling paths use,
so a producer that predates the field is never silenced by an upgrade.

## Consequences

- **The retention fix costs nothing at the moment the frame exists.** Nothing is
  cut eagerly, no encode is added and no byte of retention budget is claimed:
  the ask that had no rung to land on is the ask that should not have been made.
- **And there was no spare retention budget to spend anyway.** The premise that
  motivated an eager-cut alternative — "the scene store sits pinned at its 48 MB
  cap while the subject tile store holds under 1 MB of its 64 MB" — does not
  survive a per-camera read. Peak per-session `tileMb` / `sceneMb` over one hour
  on the hub: dev 592 **64 / 48**, dev 1439 **64 / 46**, dev 102 34 / 48, dev
  3829 11 / 48, dev 3839 5 / 47, dev 618 20 / 22, dev 104 6 / 29 — i.e. the
  BUSIEST cameras have the tile store **pinned at its own cap**, not idle. An
  eager cut would have evicted the tiles the recognisers live on, on exactly the
  cameras that produce the misses. The aggregate figure hid that because it
  averaged the busy cameras with a dozen quiet ones.
- **Correctness, not only volume.** The invisible half of this defect was worse
  than the miss: when such an ask HIT — because some other subject in that frame
  did earn a tile — the enrichment was cut from an instant the subject was not
  in, and landed in the same vector index, erroring nowhere. That is the failure
  mode [D52](adr-0052.md) exists for.
- **A coasting track's handle now ages instead of being refreshed.** A periodic
  tick during a long coast dispatches against the last MATCHED frame, which may
  be seconds old and may itself miss. That is not a regression: the fresh handle
  it replaced had no tile at all. It does mean the remaining misses shift toward
  genuinely-expired handles, which is a different and honest number.
- **The invariant now lives with the consumer that must honour it.** The gate is
  in the dispatcher rather than in the caller's loop, so a future caller of
  `TrackDetailDispatcher` inherits it instead of having to remember it — which
  is how this path came to be the one sibling that did not.

## The number that says this did NOT work

Per camera, with `tags: { deviceId }`:

- If `native crop miss` lines carrying
  `workerReason="frame N released and no retained tile for this frame"` do not
  fall by at least **60%** per hour, the diagnosis was wrong and the remaining
  population is something else.
- If total detail enrichments per track fall measurably, the gate is refusing
  work it should have kept — the scheduler's periodic tick is supposed to absorb
  a coast, and a drop means it does not.
- If `detail dispatch: coasted frames ignored` reports **0** on cameras that are
  still missing, `matchedThisFrame` is not reaching the dispatcher at all and
  the whole change is inert.

## Enforcement

`packages/addon-post-analysis/src/pipeline-analytics/__tests__/detail-dispatch-coasted-frame.spec.ts`
pins each clause: the association survives a coasted frame, a coasted frame
cannot raise the candidate peak or fire a dispatch, a real observation
afterwards still dispatches against the NEW frame, an absent field is read as
matched, a coasted frame cannot adopt an unknown track, and the counter is
per-device and cleared on dispose. It carries a harness-sanity test as well,
because every "no call was made" assertion in it is vacuous if the fake never
dispatches at all. No guard script: this is one call site, and the rule is a
property of the dispatcher rather than of the repo's shape.
