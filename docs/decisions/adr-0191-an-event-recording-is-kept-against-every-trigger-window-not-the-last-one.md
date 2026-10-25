---
id: D191
title: An event recording is kept against every trigger window, not the last one
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/band-decision.ts
  - packages/addon-pipeline/src/recorder/addon/decision-schedule.ts
---

## Context

The `events`-band keep gate held ONE scalar per trigger source
(`lastMotionMs` / `lastAudioMs`) and asked, of each finalized segment, whether
it fell inside `[lastTrigger - preBufferSec, lastTrigger + postBufferSec]`.

That reads as "does this footage belong to an event", and it is not what it
computes. A segment reaches the gate long after the media in it was captured:
ffmpeg closes the file, the playlist is polled, the successor's start corrects
the duration. Measured p50 on this cluster: **9.8 s**. Under continuous motion
the "last trigger" keeps advancing throughout that lag, so the pre-buffer test
`segEndMs < lastMotionMs - preMs` compared footage against a trigger that fired
**after** it was recorded — and deleted the earlier part of the very episode the
recorder had been started for.

With the finalize lag (9.8 s) sitting within 200 ms of the shipped
`preBufferSec` (10 s), it was a coin flip per segment. The audit of 2026-08-20
measured the result: **45 % of every byte the recorder wrote was unlinked**,
54 % duty inside windows with continuous motion, and 15 % duty on camera 1438.
The operator saw a timeline with holes in the middle of an event that was
plainly still happening.

The tempting fix — raise `preBufferSec` past the finalize lag — was rejected. It
buys margin, not correctness: it leaves the gate comparing a segment against a
trigger that post-dates it, so the same deletion returns for any camera whose
finalize lag grows (a busy hub, a slower disk, a longer segment).

## Decision

The recorder keeps a bounded LIST of merged trigger WINDOWS per source, and a
finalized segment is retained if it intersects `[firstMs - preBufferSec,
lastMs + postBufferSec]` of **any** of them. Consecutive triggers merge into one
window while they arrive within `postBufferSec` of each other — that interval is
exactly the span over which the recorder never stopped, so the footage between
them is one episode. The window's span may only ever grow: an out-of-order
trigger widens `firstMs` and never rewinds `lastMs`.

The LIVE gate is unchanged and still reads the newest window only: a trigger
opens a recording, older windows exist for the keep gate alone, and nothing
re-opens a window the post-buffer already closed.

## Consequences

- The gate now needs history where it needed one number, so the history must be
  bounded at both ends: `pruneTriggerHistory` drops a window once nothing
  unfinalized can still intersect it (`postBufferSec + TRIGGER_HISTORY_MARGIN_MS`,
  120 s — one long segment plus the first-segment grace plus the finalize lag),
  and `MAX_TRIGGER_WINDOWS` (32) is a hard backstop. At the shipped 30 s
  post-buffer, retention alone bounds a camera to three windows; a camera with
  motion every 200 ms holds exactly ONE.
- Evicting a window can only drop footage that was asked for, so the controller
  **warns** when the hard bound bites. It is not expected to ever fire.
- The discard log line now carries `motionWindows` / `audioWindows` instead of
  `lastMotionMs` / `lastAudioMs`. A single scalar could not distinguish "dropped
  200 ms past one episode" from "dropped between two episodes"; both printed the
  same line, which is why the 45 % loss was invisible in the logs for as long as
  it was.
- `preBufferSec` keeps its meaning as the retroactive KEEP bound, measured from
  the START of an episode. It is not a pre-roll knob — see [D192](adr-0192-the-broker-ring-is-the-only-pre-roll.md).

## Enforcement

`packages/addon-pipeline/src/recorder/addon/__tests__/band-decision.spec.ts` —
`segmentRetainedForEvents — an OPEN episode keeps its own footage` reproduces
the deletion (the first segment of an episode still firing 20.5 s later) and
pins that every segment of a 10-minute continuous episode survives, while
footage between two distinct episodes is still discarded. The bounding
behaviour (merge, prune, evict) is pinned in
`recordTrigger / pruneTriggerHistory — the history stays bounded`.
