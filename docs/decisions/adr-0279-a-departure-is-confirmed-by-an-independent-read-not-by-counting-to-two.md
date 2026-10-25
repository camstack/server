---
id: D279
title: A departure is confirmed by an INDEPENDENT read, not by counting to two
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-match.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-types.ts
---

## Context

[D174](adr-0174-a-parked-object-is-hard-to-forget.md) made a stationary entry
hard to destroy by applying [D49](adr-0049.md) to the wake: one departing read
only ARMS the entry, and a second read that agrees retires it. The rule was
implemented as a `Set<string>` of armed entry ids
(`stationary-registry.ts:166`), tested, and shipped.

It did not work, and the way it failed is the point of this record. Audited on
device 102 on 2026-08-28: the registry **promoted the same two parked cars five
times in 17 minutes** (17:03:37, 17:08:52, 17:11:03, 17:17:24, 17:20:02) and
retired them three times with `reason:'departed'` — while the stored images
prove neither car moved (identical position, twenty minutes apart). Between each
retirement and the next promotion sat a ~35 s flood track on the parked car,
which is the stillness valve working as designed and is the symptom's shape, not
its cause.

Reading the path, the two reads the mechanism counted came from the two least
trustworthy sources on the camera and, crucially, were **consecutive frames of
one optical event**:

- One retirement fired on the session's **first two frames, 0.9 s apart** — a
  cold h265 decode emitting loose, half-built boxes.
- Another came from a passing car occluding the parked one: measured IoU 0.36
  against the entry with the centroid outside, which is a textbook departing
  read (`stationary-match.ts:284`), reported on frame after frame of the same
  transit.
- A plain MISS also counted as the agreeing read (`stationary-match.ts:259`),
  on a camera whose media capture fails ~25% of the time.
- And `departureStrikes` had **no expiry and outlived its session**, so a
  departing read at 17:03 was still pending at 17:20 and was settled by a frame
  that had nothing to do with it.

So D49 was formally satisfied and completely defeated. Counting to two is not
the rule; the rule is that the second read must be able to DISAGREE
independently, and two frames of one event cannot.

The same defect explains the second complaint. Suppression drops detections
before the tracker (`frame-processor.ts:630`), so a live entry also prevents
identity theft; one audited track begins on a dark blue car driving and ends on
the silver parked one, a 0.22-track-diagonal jump on a 1-hit track that is below
every tracker gate. A previous investigation established that this class of
theft is smaller than the jump the growth gate exists to catch, so the tracker
gate is not the lever. Removing the false retirement removes the bait.

## Decision

A pending departure is retired only by evidence that is INDEPENDENT of the read
that armed it. Four properties, all of them required:

1. **Separation.** The confirming read must land at least
   `DEPARTURE_CONFIRM_MIN_GAP_MS` (3 000 ms) after the arming read, measured on
   the device's observed frame clock.
2. **Decay.** An unconfirmed strike expires after `DEPARTURE_STRIKE_TTL_MS`
   (30 000 ms) and is discarded before the frame is read.
3. **Cancellation.** Any confirming read clears the strike outright; an
   IoU ≥ `suppressIou` read is the strong form of it.
4. **A miss is not a read.** An absence confirms only when it is SUSTAINED:
   `DEPARTURE_ABSENCE_MIN_READS` (5) consecutive frames with no associated
   same-class detection, and only past the separation gap.

Additionally, a departing read inside `GATE_WARMUP_MS` (2 000 ms) of a session
opening is **discarded and counted**, never acted on. A session opens when the
gap between gate frames exceeds `GATE_SESSION_GAP_MS` (5 000 ms).

Every constant is derived from the audit, not chosen: 0.9 s is the observed
separation of the false pair, 5.9–7.9 fps is this pipeline's measured per-camera
rate (3 s is 18–24 frames), sessions on this camera close at `openForMs` ≈
36 000 so a 30 s decay cannot outlive the session that armed it, and 5
consecutive misses is longer than any dropout burst the frame processor's own
`dropoutMaxSkipFrames` will tolerate.

The strike is therefore a RECORD (`armedAt`, `absentReads`), not a bare id, and
it is owned and committed by `StationaryObjectRegistry.filter` rather than
travelling through the FrameProcessor: a frame whose only outcome was a strike
used to have to be special-cased upstream or the strike was silently lost.

## Consequences

- **Departure latency rises by up to 3 s.** A genuine departure now retires on
  the first read (or the fifth consecutive absence) past the gap instead of on
  the next frame. Against a 120 s promotion span and a 300 s TTL that is under
  3% of the cheapest competing timer, and the audit found the wake erring
  *toward* retiring: 65% of entries were retired inside 300 s, i.e. by a wake.
- **The wake is not weakened into a blind spot.** Both confirmation paths remain
  live and both are tested: a car whose box slides off its spot retires on a
  contradicting read, and a car that drives out of frame — which stops
  overlapping its old box within a frame or two, so a contradicting read may
  never come — retires on the sustained absence. What no longer retires is a
  single bad frame, a transit occlusion, a cold-decode box, or a dropout burst.
- **A miss alone can no longer retire anything.** The mechanism that exists for
  "the object stopped being detected on its spot" is the TTL sweep (300 s of
  OBSERVED time), and it is untouched. This is the deliberate cost: an object
  that vanishes without ever producing a departing read waits for the TTL.
- **Warm-up frames can only fail to destroy.** Confirmations, re-anchoring and
  suppression all still run inside the window; only the departure decision is
  refused.
- **A cancelled retirement is now a frequent event**, which is the mechanism
  working. It cannot be a log line of its own: the whole lifecycle (armed,
  cancelled, expired, warm-up-ignored, woken by read, woken by absence, pending)
  is rolled into ONE `stationary departure strikes` line per device per sweep,
  alongside the existing `stationary registry absorbed detections`. The
  per-retirement `stationary entry retired` line now carries `cause` and
  `strikeAgeMs` — the three retirements that produced this record would have
  been recognisable on sight from a `strikeAgeMs` of 900.
- **The promotion criterion is untouched** (ratio 0.6, span 120 s, `minAgreed`
  8, `agreeIou` 0.5), as is the stillness valve.
- A session boundary does NOT additionally clear strikes. That was the first
  shape of this fix and it was a second mechanism doing decay's job: sessions on
  this camera are minutes apart, so every carried strike is already expired by
  the next session's first frame, and the one case a boundary would have caught
  extra — two sessions a few seconds apart — is a confirmation that is genuinely
  separated in time and lands on a decoder the warm-up has already vouched for.

## Enforcement

Tests, in
`packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/__tests__/stationary-match.spec.ts`
(the pure decision) and `.../stationary-registry.spec.ts` (the committed state
and the logging):

- two departing reads **0.9 s apart do not retire** — the measured 102
  signature — and the strike is held from its ORIGINAL `armedAt`, so a drip of
  bad boxes cannot postpone a real departure;
- a departing read a full separation gap later **does** retire, with
  `cause: 'contradicting-read'`;
- a sustained absence past the gap retires with `cause: 'sustained-absence'`,
  and an absence one read short of the floor, or inside the gap, retires
  nothing;
- a strong and a weak re-confirmation each cancel a pending strike;
- a strike nobody confirmed expires, and neither a later departing read nor a
  later absence can cash the expired one in;
- a departing read inside the warm-up arms nothing and is counted;
- the whole lifecycle produces zero lines while it happens and exactly one at
  the sweep, tagged with `deviceId`.

Each of those was verified by reverting the implementing line and confirming the
assertions fail. No guard script: this is a predicate over time, not a shape.
