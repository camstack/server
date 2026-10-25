---
id: D400
title: The picture is judged on what is DELIVERED, and every branch that fails to make one says so
status: accepted
date: 2026-09-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/edge-clear.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/best-shot-promotion-log.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/last-frame-promotion.ts
  - packages/addon-post-analysis/src/shared/frame/wide-central-square-crop.ts
  - packages/addon-post-analysis/src/pipeline-analytics/debug/debug-track-analysis.ts
---

## Context

The operator marked eleven tracks `debug` on 2026-09-07 and wrote, per track,
what looked wrong. Four of the eleven are about the PICTURE, not the tracking,
and the audit
([`docs/benchmarks/2026-09-08-operator-debug-track-audit.md`](../benchmarks/2026-09-08-operator-debug-track-audit.md))
measured all four.

**1. "Il best shot è a bordo. C'è però una posizione più avanzata che non ci
costringe a usare il bordo specchiato"** [The best shot is on the edge. But there is a more advanced position that does not force us to use the mirrored edge] (`5f5f0f6e`, device 3829). The shipped
best shot is the birth frame, 9.6 px from the left border. The delivered 16:9
canvas it produces is ~21 % synthesized lateral fill; two later positions need
none. The audit's finding: **no ranking tier measures the delivered canvas.**
`isSquareContained` measures the central square, `isEdgeClear` measures the
detection box, `bboxContainment` measures border touching — the fill the
operator is looking at is invisible to ranking by construction, and is in fact
explicitly permitted by the crop module's own contract.

**2. "Questi tagli hanno uno score troppo alto, non si vedono il dorso e
testa"** [These crops have too high a score, the back and head are not visible] (`841f9b8e`, same camera). The audit has the number. `bboxContainment`
scaled its clipping penalty by how much of the touched border the box spans as a
fraction of the FRAME. On a 3840 px-wide frame, a person clipped at the head is
~400 px wide, so `spanX = 0.104` and **a decapitated person lost 5.2 %** of its
score. The calibration was written for a wide subject cut off top or bottom; a
frame's width is not a fact about the subject.

**3. "Niente primo e ultimo" [No first and last] (`59bbae2b`) and "niente ultimo" [no last] (`a99af2f3`), both
device 102, are ONE failure.** No keyFrame ⇒ no keyFrameSmall ⇒
`decideLastFramePromotion` has no `copy` source ⇒ no lastFrame. The operator saw
one capture failure as two complaints because the viewer renders per KIND and
each kind reported its own absence with no cause. `decideLastFramePromotion`
returned a bare `{promote:false}` for that case AND for the healthy already-last
case, so the close could not tell them apart and logged neither.

**4. Two reporting defects.** `previewMissReason` was written only when the
best-shot TILE ranked below native, so three of the four `MISSING_KEYFRAME`
tracks carried no reason at all — a track with a picture and no key frame still
lost its lastFrame and is still absent from every rebuild. And
`MISSING_BEST_CROP` fired on **10 of 14** tracks including the two the audit
found healthy: it fired whenever a closed track owned no crop, which is the
normal shape, because the detail plane does not run on most tracks.

**What was tried first and did not work, on complaint 1.** The obvious change is
a "no-fill beats fill" TIER above the effective score. It is wrong, and the
geometry says why: the 16:9 window is `side × 16/9` of the subject's central
square, so fill is anti-correlated with subject size — a small distant subject
near the frame centre has zero fill ALWAYS, while a close subject's window
routinely overflows. That tier would systematically hand every camera's best
shot to its most distant subject, which is the exact defect `bboxSizeScore` and
`DECISIVE_SIZE_RATIO` were added to fix (BEST_SHOT_STALE, 18.3 % of 1 717
tracks).

**And on complaint 1 the audit is explicit that the fix is not verifiable
alone.** `5f5f0f6e` had seven later edge-clear positions and the edge tier
bypasses both hysteresis and `minGapMs`, so the promotion SHOULD have fired.
Why it did not is UNKNOWN — because a promotion that fired and whose capture
missed is indistinguishable from one that never fired.

## Decision

**The delivered canvas is a ranking term, and it is a bounded WITHIN-TIER factor
— never a tier.** `canvasFillFraction` measures the
`deliveredWideCentralSquareLayout` (the layout the persisted thumbnail is
actually cut with), and it enters the comparator twice, both times below every
tier: as a factor in the effective score capped by `CANVAS_FILL_MAX_PENALTY`
(0.15, so at the real fill ceiling of `1 − 9/16` it can move a score by at most
6.6 % and cannot overturn a 7.1 % lead), and as a near-equal tie-break ranked
ABOVE centeredness — both answer "is this well framed?", and fill MEASURES the
delivered canvas while centeredness only proxies it.

**A clipping penalty is scaled by the SUBJECT'S own geometry, never by its span
across the frame.** Truncation compresses a box along the axis it was cut on, so
`clipPenaltyScale` reads the surviving remnant's aspect along that axis: full
penalty at or below 1.0, none at or above 2.5, linear between.

**Every best-shot promotion attempt is on the record**, tagged `{ deviceId }`,
with the track id, the TERM that decided (`compareBestFrame` is the single
ordering; `isEdgeAwareNewBest` is now its `accepted` bit and nothing else), both
effective scores, the candidate's measured terms, and whether a capture was
dispatched — plus a second line when a dispatched capture does not land.
Acceptances are always logged; refusals only while the track still has no
picture at all, throttled to one per 2 s.

**A branch that declines to produce media names its reason.**
`decideLastFramePromotion` returns `declinedBecause`, the close logs it, the
close writes `previewMissReason` whenever the NATIVE KEY FRAME is absent (not
only when the tile is), and the per-kind debug findings carry the cascade's
cause instead of repeating one failure three times.

**`MISSING_BEST_CROP` names only a crop that was OWED**: `hasFace` or
`hasEmbeddedFace` on the row, and no crop of any kind in the index.

## Consequences

- **The cover image of every event on every camera can move.** Two things move
  it, and they move in opposite directions from the same complaint: the
  containment re-base makes border-clipped candidates much cheaper (a
  decapitated person now loses 47.9 % instead of 5.2 %), so on a track that has
  ANY unclipped frame the unclipped frame wins far more often; the canvas-fill
  factor moves nothing on its own, being bounded under the hysteresis band for
  most candidates. On a track where EVERY frame is clipped the same way
  (`841f9b8e`) the ranking between candidates is unchanged — the same factor
  applies to all of them — which is correct and is what the audit predicted.
- **The number that says the canvas term has stopped tie-breaking**: the share
  of accepted promotions logged with `decidedBy: 'canvas-fill'`. Low single
  digits is a tie-break. Above ~10 % it is dominating and the penalty must come
  down.
- The old wide-subject case is penalised MORE, not less: a 900×400 vehicle flush
  to the bottom border went from 0.883 to 0.500 — which is what the old
  docblock claimed ("heavily penalised") and the old arithmetic never delivered.
- `previewMissReason` now appears on tracks whose tile is perfectly good. That is
  the point, and the field's cap docstring says so.
- A `MISSING_BEST_CROP` that no longer fires is not a regression: it was firing
  on healthy tracks, which is how a finding becomes noise.
- The canvas term does NOT explain `5f5f0f6e` on its own — that frame is also
  square-evicted and border-touching, so two existing tiers already ranked the
  later positions above it. Only the promotion log can say which of those fired
  and what happened next.

## Enforcement

- `packages/addon-post-analysis/src/pipeline-analytics/pipeline/__tests__/best-shot-canvas-and-clipping.spec.ts`
  pins the audit's tracks and numbers as fixtures, and pins the ORDER: the term
  never overturns the square, semantic or edge tiers, does break a within-tier
  near-equal tie, and is bounded under 6.6 %.
- A property test asserts `isEdgeAwareNewBest ≡ compareBestFrame().accepted`
  across a candidate matrix, so the ordering cannot be copied and drift.
- `best-shot-promotion-log.spec.ts` pins that an acceptance whose capture was
  suppressed is distinguishable from a refusal, and that refusal lines are
  throttled.
- `last-frame-promotion.spec.ts` pins `declinedBecause` on the `59bbae2b` and
  `a99af2f3` shapes and on the healthy already-last case.
- `debug-track-analysis.spec.ts` pins that the missing lastFrame names the
  keyFrame as its cause only when the copy source really was the reason, and
  that `MISSING_BEST_CROP` is silent on a track that never ran a detail.
- Nothing guards the "log every declining branch" rule mechanically — review
  only. It is stated in `CLAUDE.md` because three separate investigations in one
  session were spent on silences of exactly this shape.
