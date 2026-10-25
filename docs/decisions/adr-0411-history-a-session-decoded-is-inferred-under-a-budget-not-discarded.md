---
id: D411
title: History a session already decoded is INFERRED under a budget, carrying its own clock — never discarded
status: accepted
date: 2026-09-09
supersedes:
applies-to:
  - packages/addon-pipeline/src/session-decode/media-clock.ts
  - packages/addon-pipeline/src/session-decode/pre-roll-burst.ts
  - packages/addon-pipeline/src/pipeline-runner/pre-roll-lane.ts
---

## Context

An on-motion detection session asks the broker for history. The restreamer
serves it — device 102, 2026-09-08 22:48 UTC: `preRollSpanMs=3994`,
`detectionPreRollServed=true` — and the decode worker decodes the whole window
before it ever reaches the live edge. That is the design (D57, D192): the
pre-roll is how a dial reaches a decodable GOP instead of sitting blind waiting
for the camera's next IDR.

None of it reached inference. A frame-by-frame re-run of the SAME model the live
session used (`yolov9m-320-int8`, hub/openvino:gpu) over the stored recording
scored a cyclist `vehicle 0.5669` — above the 0.50 vehicle floor — at server
≈`1788900482710`, and `0.5366` 100 ms later, peaking `0.7876`. The live track
was born at `1788900484392`: **1.68 s late**, on a transit that lasted ~2.5 s.
Both above-floor frames sat in the pre-roll, and the pre-roll had been replayed
into the decoder.

Three gates killed them, and the first is the one that mattered:

1. `session-decode/frame-slot.ts` `publish()` throttled on WALL CLOCK — the
   worker handed it `Date.now()`. A catch-up burst delivers ~4 s of media inside
   a few hundred ms of wall clock, so `timestamp - lastPublishedAt <
   minIntervalMs` rejected almost the whole window and `frame.free()`d it.
2. `frame-slot.ts` latest-wins: whatever survived (1) was superseded before the
   parent's next pull.
3. `pipeline-runner/runner.ts` `reserveDetectionFrame` — the governor's
   `minIntervalMs`, also measured against `Date.now()` — and then
   `frame-queue.ts`, which is latest-only and would have collapsed a burst to one
   frame anyway.

The runner's own timing for that session reported
`frameAge={"avg":5,"p95":13,"max":18}`: nothing older than ~18 ms was ever
analyzed. The history was reconstructed, decoded, paid for in full, and freed.

The first thing tried was to relax the throttle. That is wrong twice over: it
slows nothing down but it makes the LIVE path admit stale frames, and it still
leaves every admitted history frame stamped `capturedAt: Date.now()` by both
`FrameSlot.publish` and `session-decode-pump.ts`'s `toDecodedFrame` — which
would date a track's `firstSeen`, its positions, its media and the
notification's instant at SESSION OPEN. A silently wrong timestamp is worse than
the late birth: nothing downstream can tell it from a right one.

## Decision

History a session has already decoded is INFERRED, not discarded — under an
explicit budget, carrying its own clock, and never ahead of live.

- **A pre-roll frame carries its own moment.** `media-clock.ts` anchors the
  session on its first decoded frame (`preRollMs` in the past, because that is
  what the dial asked for), converts each frame's pts, and CLAMPS to now so no
  frame is ever dated in the future. A source whose pts cannot be converted gets
  no clock and therefore no burst — a fabricated media time is refused, never
  approximated.
- **The burst paces in MEDIA time, under a budget.** `pre-roll-burst.ts` plans a
  media stride over the window and enforces a frame budget and a wall-clock
  ceiling. Over budget it SUBSAMPLES the whole window rather than truncating it:
  the measured miss is at the OLD end, so drop-oldest would fix nothing.
- **Live always wins.** History rides a bounded FIFO of its own
  (`pre-roll-lane.ts`) — never the latest-only live queue — drained only after
  every camera's live queue came back empty, and never taking the last inference
  permit (`PRE_ROLL_PERMIT_RESERVE`).
- **A dropped frame is named.** One line per session
  (`session-decode: pre-roll catch-up burst`, `tags: { deviceId }`) reports
  offered / inferred / dropped with a per-reason breakdown, the stride, and
  whether the runner's lane refused any.
- **The live path is untouched.** A live frame still paces on wall clock through
  the same `FrameSlot` throttle and the same governor interval, byte for byte.

The switch and the budget are ONE number (`preRollInferenceFrames`, gated by
`preRollInferenceEnabled`): `false` and `0` mean the same thing at every layer,
and two ways to say it are two ways to disagree (D62's lesson, one layer down).

## Consequences

**ON by default, and the default is the argument.** The pre-roll is already
requested, served, decoded and paid for; what shipped was a last-moment discard.
Shipping the fix opt-in would ship the bug, because an operator cannot discover
a setting whose absence looks exactly like a camera that noticed the cyclist
late. What makes ON safe is the BOUND, not the switch.

**Cost.** 12 frames × ~40 ms inference ≈ 480 ms of ONE permit, one-shot at
session open. This hub measured 56 frames/10 s at 40 ms for one camera, so a
burst is roughly one extra second of that camera's ordinary duty, taken only
while a permit is spare. Several cameras opening together cannot storm the node:
the permit reserve makes the lane yield, and the per-node decode spawn gate
(`acquireSpawnSlot`) already staggers session opens.

**What now has to stay true.** `capturedAt` is the only clock a consumer may
read for a pre-roll frame — anything that re-stamps `Date.now()` downstream
re-introduces the timestamp fault the burst exists to avoid. And the lane must
stay a FIFO: making it latest-only for tidiness restores gate 3.

**What this does not do.** It does not create history. A source that was idle
when motion fired has none, the burst plans nothing, and no line is logged —
deliberately, so "no burst" and "a burst that found nothing" stay distinct.

## Enforcement

Unit tests, no guard script:

- `session-decode/__tests__/media-clock.spec.ts` — the anchor, the pts
  conversion, and the never-in-the-future clamp.
- `session-decode/__tests__/pre-roll-burst.spec.ts` — media-time striding under
  a wall-clock burst (the exact shape that defeats the shipped throttle), both
  budgets, the live-edge end, and the per-reason accounting.
- `pipeline-runner/__tests__/runner-pre-roll-lane.spec.ts` — that a burst
  SURVIVES the lane instead of collapsing to its newest frame, that a live frame
  is always picked first, that the last permit is never taken, and that a
  pre-roll frame's own `capturedAt` reaches the result callback.

Review only for the rule that a consumer must not re-stamp `capturedAt`. There
is no guard for it, which is worth knowing: it is the failure mode most likely
to come back.
