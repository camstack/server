---
id: D238
title: A scrub frame has a deadline, and the read aims where the finger will be
status: accepted
date: 2026-08-25
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/recorded/recorded-feeder.ts
  - packages/addon-pipeline/src/stream-broker/recorded/scrub-drag-stats.ts
---

## Context

The operator's report was "scrub provato, quasi 0 frame, playback parte dopo una
vita" [scrub tried, almost 0 frames, playback starts after an eternity], worse the wider the window. The
[the reference NVR teardown](../design/2026-08-25-reference-scrub-teardown-and-plan.md)
named the mechanism: a scrub frame had **no deadline**. The only bound was
`SEGMENT_TIMEOUT_MS = 8000` per RPC, against a cold read measured at p50 531 ms,
p95 1.4–2 s and a 9.2 s max. The reference design spends ≤1000 ms on the whole
animation and gives every frame the remaining window, dropping any frame it
cannot produce in time.

A drag bench over the real `RecordedFeeder`, with read latencies sampled from
that census, reproduced the complaint exactly: a 3-second fling across two hours
delivered **4 frames**, and the median painted frame was **1 224 769 ms — twenty
minutes — behind the finger**.

The first thing tried was the deadline alone, faithfully ported. It measured
almost nothing: staleness p50 fell 2 %. The deadline bounds the *tail*, but
dropping a frame does not make a spindle faster, and on a fling every read is a
miss either way. The number that mattered turned out to be a different one:
**staleness is `readLatency × dragVelocity`**, and it is arithmetic, not I/O.
The frame we paint is the frame a read *started for*, one read time ago.

## Decision

A scrub tick is bounded by a per-frame deadline, its reads are single-flight
with retargeting, and a steady drag reads AHEAD of the finger:

1. **Deadline.** The whole miss path (locate + snap + read + demux) races
   `SCRUB_TICK_DEADLINE_MS = 700` — `SCRUB_FIRST_TICK_DEADLINE_MS = 2500` while
   the drag has painted nothing, because dropping the first frame costs the
   whole picture. On expiry the FRAME is abandoned; the read is not — it
   finishes into the session fragment cache, so the work becomes the next tick's
   hit instead of nothing.
2. **Single flight.** At most `SCRUB_RESOLVE_MAX_INFLIGHT = 2` fragment
   resolutions run at once; a tick whose target is within `SCRUB_RIDE_WINDOW_MS`
   of one in flight rides it instead of adding a seek.
3. **Retarget.** A landed fragment is served at the instant the finger is on
   NOW, never the instant its read was issued for. `pickScrubIndex` /
   `clampIntoSegment` reduce an out-of-range instant to the nearest frame the
   fragment holds, so aiming at the finger can never paint something we do not
   have.
4. **Lead.** A drag with a sustained direction (≥2 same-direction POINTER
   samples — pointer, not pushes: a 3 s drag makes ~75 of the first and ~4 of
   the second) and at least one measured read aims its read at
   `target + mediaVelocity × medianRecentReadMs`.

Every one of these is COUNTED on `scrub-feeder:drag-end`: `deadlineMisses`,
`resolveJoins`, `retargets`, `leadMsP50`/`leadMsMax`.

## Consequences

Measured on the drag bench, five seeds per scenario, before → after:

| | fling 2 h/3 s | careful 5 min/3 s | nudge 30 s/1.5 s |
| --- | --- | --- | --- |
| staleness p50 | 1 224 769 → **525 087** | 51 117 → **16 572** | 4 268 → **2 597** |
| staleness p90 | 1 535 211 → **757 471** | 64 062 → **30 988** | 4 512 → **2 751** |
| staleness max | 2 147 601 → **1 721 983** | 89 445 → **62 800** | 12 436 → **4 804** |
| frames / drag | 4 → 4 | 4 → **5** | 17 → 17 |
| finger-up → correct frame | never | 297 → **265** | 126 → **30** |

What this does NOT fix, and must not be claimed: **time to the FIRST frame is
unchanged** (~600 ms in the bench, `firstPushMs` p90 1.3 s in the field). It is
one cold read and no scheduling change can shorten it — that is the warm cache
and the disk (P0/P5 of the teardown).

The lead is a prediction and it can overshoot; the retarget is what makes that
safe, which means **rule 4 must never ship without rule 3**. A lead with no
retarget measured WORSE than no lead at all on short drags (+62 % staleness on
the nudge) — the overshoot became the error.

`SCRUB_TICK_DEADLINE_MS` must stay above the cold-read p50. A deadline that
drops the median frame makes the picture worse, not fresher; if the disk
changes, this number moves with it.

## Enforcement

`packages/addon-pipeline/src/stream-broker/recorded/__tests__/scrub-deadline.spec.ts`
— nine tests. The deadline and the retarget were each verified by REMOVAL: with
`raceDeadline` replaced by a plain `await`, two tests fail; with the retarget
branch disabled, one fails.

In production the guard is the census: `deadlineMisses` high with `ticks`
collapsing means the deadline is too tight for the disk; `leadMsMax` large with
`retargets` at zero means the velocity estimate is wrong.
