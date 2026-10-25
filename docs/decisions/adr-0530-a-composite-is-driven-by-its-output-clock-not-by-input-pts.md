---
id: D530
title: A composite is driven by its output clock, not by input PTS
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/system/src/builtins/camera-grid/grid-compositor.ts
  - packages/system/src/builtins/camera-grid/grid-canvas.ts
  - packages/system/src/builtins/camera-grid/grid-tile-feed.ts
  - packages/system/src/builtins/camera-grid/grid-tile-plan.ts
  - packages/system/src/builtins/camera-grid/grid-compositor-child.ts
---

## Context

One tile of the grid sat seconds behind the other, permanently, with the
picture otherwise fluid. `overlay` pairs its inputs BY PTS and ffmpeg gives each
input pts 0 at ITS OWN first frame, so two sources that joined at different
moments compose different moments for the life of the child, with nothing to
correct it.

Everything cheaper was tried and MEASURED first, and each result closed a door:

- `-use_wallclock_as_timestamps` re-times by arrival. It made the tiles agree
  and destroyed the pacing — ten stalls over a second in an 18 s run, against
  none. Reverted the same day.
- The probe budget was the dominant term and was fixed (D527): 9 s to first
  frame became 2.3 s and the skew fell from 4-5 s to 0-1 s. What remained was
  the genuine spread in when each source's first key frame arrives.
- `-copyts` changes nothing: the broker re-bases per session, both restreams
  report `pts_time:0`, so there is no shared timeline to `trim` against.
- Serving each dial from the newest key frame the ring already holds only moves
  the offsets into the past — those key frames are of different ages, and pts 0
  still lands on whatever arrives first.

The residual drifts over hours as two independent GOPs slide through each other:
0.5 s at 13:05, 3 s at 13:50, on the same pair of cameras. The operator's
requirement was explicit — *"il delay va bene, ma il gap tra i due deve essere
0"* [the delay is fine, but the gap between the two must be 0] — and no flag reaches it.

## Decision

The composition is assembled by this addon and driven by the OUTPUT's clock. One
decoder per cell writes raw yuv420p tiles; each tile's newest frame is kept and
everything behind it dropped; a tick copies the current frames into a canvas and
hands it to one encoder.

There is no pairing to get wrong: every tick asks each source what it looks like
NOW. The gap is zero by construction rather than by tuning.

Verified end to end with real ffmpeg before shipping, with one decoder started
deliberately 3 s after the other — the shape of a source whose key frame is a
GOP away. Reading the tiles' own burnt-in clocks out of the composed picture:

```
first composed frame   both tiles black          the picture exists at tick 1
at 1 s                 16:39:38 | (black)        the late tile is still empty
at the end             16:39:42 | 16:39:42       zero gap, after a 3 s stagger
```

## Consequences

**The cold start goes away with it.** A cell with no frame is black, not a
reason to wait, so the picture exists from the first tick and cells fill in.
What used to be spent waiting for the slowest source's first key frame is now
spent watching the grid assemble itself.

**It buys correctness, not CPU.** It pays the same N decodes ffmpeg paid, in N
children instead of one. It does NOT reuse the frames the detection pipeline
decodes: those live in per-session decode workers behind two process
boundaries, the shm plane that once joined them was removed on 2026-07-16, and
what the pipeline retains is a model-sized view (320x180 JPEG, on demand), not a
tile. plus catalog's birdseye can composite detect frames; this architecture cannot.

**A camera in two cells is decoded twice.** The single ffmpeg made it one input;
the repo has one argv builder and it expresses one output per process. Since
D528 every source is read at its cheapest stream, so the duplicate is a second
640x360 decode, not a second 4 MP one. Teaching the builder several outputs
would buy it back and is the right change if a grid ever shows one camera many
times.

**Back-pressure is a skipped tick, never a queue.** A raw canvas frame is 3.1 MB
at 1080p; a queue of them is how a stalled encoder becomes an OOM, and a dropped
frame in a live composite costs nothing anybody can see.

**Raw video has no framing, so a feed that loses bytes mid-frame never
re-syncs.** A pipe cannot lose bytes, which is why this is acceptable — but it
is why the feed cuts on a fixed frame length and why a decoder is never
restarted under a live feed.

**Any child exiting ends the composition**, as with the single child before it.
Leaving a dead tile frozen while the others run would be a nicer picture and a
worse fact: the operator would be looking at a camera that stopped minutes ago
with nothing saying so.

## Enforcement

`grid-canvas.spec.ts` pins the even-boundary refusals and the neutral-chroma
clear; `grid-tile-feed.spec.ts` pins drop-to-newest and the memory bound;
`grid-tile-plan.spec.ts` pins the even snapping and the clamp;
`grid-compositor.spec.ts` pins emit-from-the-first-tick, hold-the-last-frame and
back-pressure; `grid-compositor-invocation.spec.ts` pins both argv.
