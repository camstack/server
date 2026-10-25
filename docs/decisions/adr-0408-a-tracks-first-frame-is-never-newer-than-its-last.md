---
id: D408
title: A track's firstFrame is never newer than its lastFrame
status: accepted
date: 2026-09-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/birth-first-frame-gate.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/first-last-frame-order.ts
---

## Context

The operator wrote it by hand three times on device 3829 within one minute —
once as *"Ancora ultimo frame prima del primo"* [Still last frame before the first]. Verified against the live hub
(2026-09-08 16:09 UTC):

| track | firstSeen → lastSeen | keyFrame / thumbnail / lastFrame | firstFrame |
| --- | --- | --- | --- |
| `d035f251` | +0 → +1712 ms | +326 ms | **+2163 ms** |
| `448678bb` | +0 → +1609 ms | +223 ms | **+2060 ms** |
| `7628b19d` | +0 → +870 ms | +0 ms | **+260 ms** |

All three are `person`, all three under 2 s, all three also marked *"traccia
partita in ritardo"*. On the first two the `firstFrame` post-dates the track's
own `lastSeen` by ~450 ms: the stored "primo" tile is a crop of a scene the
subject had already left.

**One cause, in the `firstFrame` schedule.** The `firstFrame` is captured at the
**confirmed birth**, not at the track's first frame, and the confirmation gate
defers an undecided birth for up to `confirmationGateMaxDeferralMs` — 2 s by
default — before releasing it (`index.ts`, the `bornCandidates` /
`deferredBirths` pass). `d035f251` (+2163) and `448678bb` (+2060) each sat out
the full deferral; `7628b19d` (+260) took one extra round. Meanwhile `keyFrame`,
`thumbnail` and the close-time `lastFrame` copy are all stamped at the earlier
frame they were actually cut from, so the "primo" tile lands after the "ultimo"
one. The `lastFrame` promotion is INNOCENT: `decideLastFramePromotion`'s `copy`
mode copies `keyFrameSmall` bytes and its timestamp faithfully, and for a
sub-interval track that IS the honest answer.

The deferral can also run past the subject. `d035f251`'s last matched frame was
+1712; the birth was released at +2163 on a frame the tracker was COASTING
through. `collectFirstFrameRetries` has refused a coasted frame since D397 —
`buildSnapshotTargets` and `TrackDetailDispatcher` too — but the BIRTH push
never did. It was gated on the frame handle alone.

Two things were rejected. **Clamping the stored timestamp to `firstSeen`** — it
would make the row's instant disagree with the pixels it names, which is the
class of lie D399 exists to prevent. **Dropping the retry** — D58 is explicit
that media a later pass depends on is retried until it lands; the pending mark
is untouched here and only one dispatch is withheld.

## Decision

A track's `firstFrame` is **the earliest view it holds, and never newer than its
`lastFrame`**. Two rules, one at each end:

1. The confirmed-birth `firstFrame` capture is dispatched only from a frame the
   subject was **OBSERVED** in — `decideBirthFirstFrameCapture` refuses a
   `coasted-frame` exactly as every other media path does, and the refusal is
   logged with `tags: { deviceId }` and the `deferredMs` that produced it. The
   `firstFramePending` mark stays set, so the first later matched+handled frame
   still recovers the capture.
2. At close, AFTER the `lastFrame` promotion, a pair whose `firstFrame` is
   strictly newer than its `lastFrame` has its two slots **swapped**
   (`decideFirstLastFrameOrder` → `MediaStore.swapFirstAndLastFrame`). Both rows
   are the track's own stored pixels and the only thing wrong with them is which
   slot they sit in, so the repair moves bytes between slots — it never deletes,
   re-fetches or re-encodes. `first === last` is **not** an inversion: a track
   shorter than the lastFrame interval legitimately collapses both slots onto
   one frame, and that is what the `keyFrameSmall` copy is for.

## Consequences

- A track confirmed on a coasted frame that never matches again closes with **no
  `firstFrame`**. That is reported honestly as `MISSING_FIRSTFRAME` rather than
  filled with a tile that lies about both its pixels and its instant.
- The swap is a **warn**, not a silent correction: it is the symptom of a capture
  arriving out of order upstream, and a quiet repair would hide the rate.
- The late-start behaviour itself — a confirmation gate that releases a birth
  after the subject is gone, which is what makes the tracks short AND late — is
  **not** addressed here and remains open.
- Nothing may re-introduce a `firstFrame` timestamp that is not the instant its
  pixels were captured. Clamping the row to `firstSeen` is forbidden.

## Enforcement

- `decideBirthFirstFrameCapture` and `decideFirstLastFrameOrder` are pure and
  unit-tested (`pipeline/__tests__/birth-first-frame-gate.spec.ts`,
  `pipeline/__tests__/first-last-frame-order.spec.ts`); the close-path wiring is
  asserted in `pipeline/__tests__/track-close.spec.ts`.
- The invariant is machine-checked on live data by the debug analysis:
  `FIRSTFRAME_AFTER_LASTFRAME` (the media inversion, at any point in a track's
  life) and `FIRSTFRAME_AFTER_TRACK_END` (a capture past `lastSeen`, closed
  tracks only). Before these, the only detector was the operator's eye.
