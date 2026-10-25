---
id: D213
title: A best shot prefers the frame that PROVED something — recognitions promote their frame in the ranking, below the square-containment tier
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/semantic-promotion.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/edge-clear.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/best-detection-tracker.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/best-selection-policies.ts
---

## Context

Track 3892b82b… (device 104, 2026-08-21 11:13): a person track lived 58s and
carried exactly ONE face-bearing frame — the frame ArcFace scored 0.507
against the operator's own identity. The stored best shot showed the subject
from the back: the ranking (confidence × containment × size, edge and square
tiers) had never heard of the face, because every recognition — face match,
plate read, fine classification — arrives over the async detail plane AFTER
`buildSnapshotTargets` has already ranked the frame on geometry alone. The
frame that proved WHO was in the scene routinely lost to a bigger anonymous
view. Operator directive, verbatim: "se una faccia viene ben distinta,
dovrebbe alzare quel frame come migliore, così come per le plates,
classificazioni etc". [If a face is clearly distinct, it should raise that frame to best, just like for plates, classifications etc.]

What was tried first: nothing directly — but the adjacent failure is D212's
track ec0eb76d…, where a tier bolted on top of everything (square containment)
was the fix. That ordering constraint shapes this record: a recognition must
NOT outrank square delivery, or the "proved" frame with the subject glued to
the border would resurrect the delivered-background best shot D212 just
killed.

## Decision

The best-frame ranking carries a SEMANTIC tier: a frame from which a
recognition actually SUCCEEDED — a per-frame gallery face auto-match
(threshold + margin + size floor + min-identity-samples, deliberately BEFORE
`confirmFrames` confirms), an attributed plate read, or an accepted fine
classification (`trackWritten`) — outranks any frame that proved nothing.
Tier order, outermost first: square-containment (D212) > semantic >
edge-clear > effective score. The signal is attribution-time RE-SCORE, never
a second derivation: `promoteSemanticBestFrame` re-offers the recognition
frame (the detail plane's own bbox/confidence/timestamp) to the SAME ranking
with the semantic bit, and when it wins and the detail plane's `frameHandle`
is still live, the boxed `thumbnail` + native `keyFrame` re-fire through the
standard scheduler-held capture paths. Pixels gone ⇒ the ranking still locks
(a later anonymous frame can no longer displace the proved peak) and the
dropped capture is logged. Only `BEST_FRAME_POLICY` declares
`semanticAware: true` — the face/object-embedding selectors rank landmark
precision, not shots.

## Consequences

- A track's best shot can now change AFTER its geometric peak, once — when a
  recognition lands. The capture cost is bounded by the existing coalesce
  keys and per-device budget (the semantic path reuses them verbatim).
- A semantic frame whose delivered square shows background still loses
  (D212 stays on top); a semantic edge-touching frame beats an anonymous
  edge-clear one by design.
- `isDecisiveImprovement` never fires on a semantic downgrade — a bigger view
  cannot rate-limit-bypass its way past a proved frame.
- The recognition-frame captures are best-effort: a detail result that
  arrives after the shm/native windows closed promotes the ranking only.

## Enforcement

`pipeline/__tests__/edge-clear.spec.ts` (tier order incl. the D212
interaction), `pipeline/__tests__/best-detection-tracker.spec.ts` (tier
upgrade bypass, markSemantic, semanticAware gating),
`pipeline/__tests__/best-selection-policies.spec.ts` (policy table pin),
`pipeline/__tests__/semantic-promotion.spec.ts` (re-score + capture gating),
`__tests__/face-recognizer-semantic.spec.ts` (auto-match fires, suggestion
band does not).
