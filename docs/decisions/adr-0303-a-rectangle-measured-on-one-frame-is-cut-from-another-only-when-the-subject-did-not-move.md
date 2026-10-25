---
id: D303
title: A rectangle measured on one frame is cut from another only when the subject did not move
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/subject-agreement.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/keyframe-crop.ts
---

## Context

Two durable display crops cut a rectangle out of a frame that is not the frame
the rectangle was measured on, because the frame it *was* measured on is gone by
then:

- the close-time **thumbnail** derive cuts the track's best-seen subject box out
  of the persisted native `keyFrame` (`track-close.ts`);
- the **plate gallery**'s last-resort crop cuts the plate rect from the best OCR
  read out of that same `keyFrame` (`plate-recognizer.ts`).

Both were guarded on elapsed time alone — `KEYFRAME_CROP_MAX_SKEW_MS` = 1500 —
and **time is not the quantity that decides whether the cut is honest**. The
2026-08-30 triage of the operator's debug-marked tracks pulled every image and
looked at it (`docs/design/2026-08-30-debug-marked-tracks-media-triage.md`). Two
crops were wrong and one was right, and the right one had the *largest* skew:

| track | stored image | skew | subject IoU across the two instants |
| --- | --- | --- | --- |
| `e9c024bb` | a windshield | 1179 ms | **0.063** |
| `4126f977` | gravel | 531 ms | **0.318** |
| `7613c0fa` | the plate, framed | 2579 ms | **1.000** |

The ordering is the whole argument. 1.5 s is nothing for a parked car and
hundreds of native pixels for a car crossing 102's frame.

The thumbnail side had additionally lost its guard outright. On 2026-08-24,
 changed the close-time derive to pass `timestamp: keyFrame.timestamp`
— so the guard compared the keyFrame with **itself**, `skewMs: 0` by
construction, and no cross-time cut could ever be refused again. That change was
made to fix track 20da3195, which had closed with no tile because a *later*
best-seen timestamp tripped the temporal guard; the fix removed the only
protection against cutting a rectangle from the wrong moment, and `ba12ed7b`
then stored a 405 KB thumbnail of pavement and parked cars for a person who was
elsewhere at the keyFrame instant. A unit test asserted the disarmed behaviour
by name (`crops the KEYFRAME instant, not a later best-seen`), which is why the
regression survived six days of green suites — the leftover read as
verification.

The same commit also caused D294 (a settings view bound to a backend that had
stopped existing). One commit, two silent regressions, both found six days later
by two unrelated investigations.

## Decision

**A rectangle measured at instant A is cut from the pixels of instant B only
when the subject's own position trail shows it occupied the same box at both
instants.** The predicate is `subjectAgreement` — one function, whose only
caller is `createKeyFrameCrop` — and it answers with `agrees` / `moved` /
`unknown`:

- `agrees` (subject-box IoU ≥ `KEYFRAME_CROP_MIN_SUBJECT_IOU`) — cut, **whatever
  the skew**. This is what makes a stationary subject at 2.5 s legal, and it is
  the correct answer to 20da3195, which the 08-24 commit answered by deleting
  the guard instead.
- `moved` — refuse, **whatever the skew**.
- `unknown` (no trail, or a trail downsampled past one of the instants) — fall
  back to `maxSkewMs` on the two REAL instants. An absent read changes nothing
  (D49).

Consequently a caller passes the instant its **rectangle** was measured at,
never the instant of the pixels it is cutting from. Handing the guard a pair of
identical instants is not a shortcut, it is a disarm.

The threshold is **0.5**: the midpoint of the empirical gap between the worst
confirmed-wrong crop (0.318) and the confirmed-right one (1.000), and well below
the 0.83 floor of the healthy population (subject IoU across a 1500 ms lag on
the eight debug tracks whose tiles do frame their subject: 0.83–1.00). It is one
cluster-wide constant, never per-node and never per-camera.

## Consequences

- **A refusal is not a lost tile.** The close path falls through to the retained
  detection-raster crop, which is right-moment pixels by construction, so a
  false refusal costs resolution, not the image. On the plate path a refusal
  *does* mean the row persists with no crop — so that branch logs, per camera.
- **Every keyFrame-derived crop needs the track's position trail at the call
  site.** `expireStale` removes the track from the live map before the close
  runs, so the trail must be threaded from the closer (`t.positions`) — into the
  thumbnail derive and into `PlateRecognizer.onTrackEnd`. There is no later
  place to look it up.
- **A pending preview upgrade carries its box's instant.** The late-keyFrame
  redeem cuts the same cross-time rectangle and had the same disarm; an entry
  recorded before this record cannot be bounded and is refused rather than cut
  blind. Self-clearing — the registry's TTL is 15 minutes.
- **The `motion` verdict rides the success line** (`agrees` vs `unknown`), so
  the regime is auditable per camera instead of readable only as "it stopped
  complaining".
- This does **not** touch `deriveDetailCropRect` (D52). That is the vector
  index's one crop derivation and it stays the runner's. This is a guard on the
  DISPLAY crops, and it is likewise one implementation with one caller.

## Enforcement

Unit tests, and they are disarm-verified: `keyframe-crop.spec.ts` holds the
motion guard as a 2×2 over (subject moved / stood still) × (skew inside /
outside the temporal bound), so a guard that refuses everything and a guard that
does nothing fail *disjoint* halves of the table and neither can pass.
`track-close.spec.ts` and `plate-recognizer.spec.ts` wire the REAL
`createKeyFrameCrop` and assert the walking/standing split end-to-end. Reverting
any one of the seven implementing lines turns 1–4 named tests red; the full
matrix is in the session log.

No guard script: the failure is a wrong *image*, which no static check sees. The
standing detector is the read-only IoU query over stored `positions` that this
record's table came from.
