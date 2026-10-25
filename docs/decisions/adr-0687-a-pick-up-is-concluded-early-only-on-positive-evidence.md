---
id: D687
title: A pick-up is concluded early only on positive evidence, and only on a camera that opted in
status: accepted
date: 2026-09-30
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-stillness-tracker.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-stillness-sweep.ts
  - packages/addon-pipeline/src/pipeline-runner/motion-settle-governor.ts
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/package-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/settings-schema.ts
  - packages/addon-post-analysis/src/pipeline-analytics/tracking-bench/tape-schema.ts
  - packages/addon-post-analysis/src/pipeline-analytics/tracking-bench/recorder/frame-record.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
  - packages/types/src/types/detection.ts
---

## Context

Camera 101 on 2026-09-30:

- The parcel was last seen at 15:23:19 CEST.
- The collector was in the drop-off zone from 15:23:20.
- The pick-up was concluded at 15:28:36, about 5.5 minutes late:
  - 300 s of that was `PACKAGE_STILLNESS_TTL_MS`.
  - 29 s was waiting for the next analysed frame. Since F4, the sweep closes
    this gap when there is an absence read.

The tracker could not tell apart two situations, both of which arrive as a
frame with no package box:

- "The package step looked at the doormat and it was empty".
- "Nobody looked": the motion-settle governor gated the step off, or the camera
  decoded nothing.

The only safe rule for both was the long TTL. Shortening the TTL was rejected:
on a quiet camera, the first frame after a silence is the look that re-sights a
parcel that is still there.

**Measured before deciding (read-only).** Sources:

- The hub's D681 tracking tapes of 101, 07:07 to 16:48 CEST: 22,522 frames.
- The runner's `package-detection dispatched` lines for the same window: 470
  looks. These log lines use the hub's local clock (CEST). Read as UTC, they
  would align with nothing.

Results:

- 6 looks saw the parcel. These were all six of its sightings, 15:22:43 to
  15:23:19.
- 3 looks were occluded by a person box.
- 460 looks found nothing. All of them fell outside the parcel's life, except
  the reads that followed the pick-up.
- Replaying the rule below over those looks, it would have concluded the
  pick-up at 15:23:42, 23 s after the last sighting and 22 s after the
  collector was born, instead of 15:28:36.
- False departures (the parcel re-sighted after the rule fired): 0 of 1.

A sample of one delivery on one camera says nothing about the false-departure
risk. It is the only package the retained data holds: tapes are kept one day,
only 101 runs the package step, and before this change no store recorded which
frames the step looked at.

## Decision

**A promoted parcel departs ahead of its TTL only on positive evidence, and
only on a camera whose `packageDropEarlyPickupEnabled` is on. The default is
off.** All of the following must hold:

- At least `PACKAGE_EARLY_PICKUP_MIN_READS = 3` absence reads since the parcel's
  last sighting. An absence read is a frame on which the package step looked
  (`FrameResult.packageLooked`, stamped by the runner from the governor's
  dispatch and never on a shed frame) and found no box at the parcel's place.
  No person, vehicle or animal box may overlap that place. Two reads closer
  than 2 s count as one.
  - **"No box" is judged against the package step's RAW output**
    (`FrameResult.detections` plus the below-threshold `discarded` boxes of a
    package class; `package-look-evidence.ts`), never the tracker's
    (fix round 1). The tracker drops a parcel it is still detecting: a lost
    track, a retracted birth, the area gate. On 101 at 15:22:57–15:23:08 each
    of those would have read "empty doormat".
  - **A raw box at the place (IoU ≥ 0.3) is a PRESENCE**, and it clears
    every read so far.
  - **The parcel counts as SEEN on any frame with a raw presence, looked or
    not** (re-review R2). Its `lastSeenAt` moves: the TTL ages from there,
    and the pick-up instant is that last presence. So the frame-path TTL can
    no longer conclude a departure on the very frame whose raw boxes show
    the parcel.
    - Before this change, a parcel the detector kept returning but the
      tracker kept dropping was "picked up" 300 s after its last TRACKED
      sighting.
    - This also closes the report's item 4(b) for the current tracker.
- The reads span at least `PACKAGE_EARLY_PICKUP_MIN_SPAN_MS = 10 s`, first to
  last.
- Somebody was in the drop-off zone at or after the last sighting. Without
  that, nothing is concluded early, and the TTL judges the disappearance as
  detector loss, as before.
  - **An activity window of 0 never concludes early** (fix round 1). That
    window switches the pick-up gate off, but it must not switch this one
    off, since nobody can then be known to be there.
  - **Complete evidence that concludes nothing is logged once per
    candidate:** `early pick-up evidence complete — nobody around, left to
    the TTL`, with `reason: no-activity-window | nobody-around`.
- A re-sighting clears every read it contradicts (D49).

Silence keeps the 300 s TTL. The departure line says `rule: early | ttl` and
`via: frame | sweep`.

**Enabling it by default needs a meaningful sample.** Tapes now record the look
as `pl`, so the replay above becomes possible on every delivery a taped camera
sees. Enable the rule by default once it has been replayed over a meaningful
number of pick-ups with zero false departures.

## Consequences

- On an opted-in camera, a pick-up is concluded within about 20–40 s of
  happening. The notification's anchored moment may then still be inside the
  clip ring, so the gif is cut from the ring and not the recordings (D686).
- `@camstack/types` gained `FrameResult.packageLooked`. `addon-pipeline` stamps
  it, and `addon-post-analysis` reads it. A runner older than the field never
  stamps it, so no absence is ever attested: the early rule and the F4 sweep
  are inert and the TTL decides, exactly as before. The two addons need not
  ship together.
- The tape schema gained the optional `pl` under v1. Tapes written before it
  never attest a look. `TapeFrameSchema` is strict, so a reader older than
  this change (a rollback within the 1-day retention, or the `feat/tracker-v2`
  worktree's own schema until it is rebased) rejects every frame carrying
  `pl`. The live runtime is unaffected in both directions.
- The same raw-output basis and the same "most recent look" state govern the
  F4 sweep. Since fix round 1 the sweep needs `PACKAGE_SWEEP_MIN_READS = 2`
  absence reads, and the MOST RECENT look must be an absence (not occluded,
  not a raw presence). A single read, possibly minutes stale, never destroys
  a delivered parcel (D49).

## Enforcement

- Fix round 1 added the following, each red with its gate removed:
  - `package-stillness-sweep.spec.ts`:
    - one read is not enough;
    - an occluded last look waits;
    - a raw box the tracker dropped is a presence;
    - a raw presence clears earlier reads;
    - a look without raw data attests nothing.
  - `package-early-pickup.spec.ts`:
    - a raw box blocks the early rule;
    - window 0 blocks it and is said once;
    - nobody around is said once.
  - `package-look-evidence.spec.ts` checks that the evidence is built from the
    frame.
  - `package-stillness-wiring-e2e.spec.ts`, through the BOOTED addon:
    - the 5 s tick drives the sweep;
    - a sweep throw is caught and named;
    - `looked`, the raw boxes and `earlyPickup` reach the tracker.
  - `package-looked-through-run-inference.spec.ts`, through the runner's
    `runInference`: the stamp follows the dispatched steps.

- `package-early-pickup.spec.ts` covers the rule itself:
  - The third unoccluded empty look spanning 10 s, with the collector around,
    concludes the pick-up.
  - Nothing is concluded early when:
    - the camera has not opted in;
    - the reads span less than 10 s;
    - there are only two reads;
    - the step did not look;
    - a person box covers the parcel's place;
    - nobody was around;
    - the parcel is re-sighted between the reads.
  - The setting defaults to off.
  - Each gate was disarmed and the test was seen red: the opt-in, the span, the
    read count, the activity gate, and the default.
- `package-stillness-sweep.spec.ts` and
  `package-stillness-sweep-driver.spec.ts` cover the absence-read mechanics
  shared with F4: the looked gate, the occluder, and the reset on re-sighting.
- `package-looked-stamp.spec.ts` covers the runner stamp: no stamp on a shed
  frame, a gated-off step, or a disabled step.
- `frame-record-package-look.spec.ts` covers the tape field.
