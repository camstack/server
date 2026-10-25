---
id: D212
title: A best shot's SQUARE view must deliver the subject — rank frames by delivered-square containment, and when no frame qualifies, anchor the square at the border
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-post-analysis/src/shared/frame/wide-central-square-crop.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/edge-clear.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/best-detection-tracker.ts
---

## Context

Track ec0eb76d… (device 108): a person stood glued to the RIGHT frame edge for
the track's entire 5s life. The best-shot square view — the region
`makeSquareThumb` blindly center-crops out of the 16:9 `thumbnail` canvas —
showed a bed and a doorway, no person at all. The wide raster contained him at
its right edge; the delivered SQUARE did not.

The mechanism is the deliberate 2026-08-20 exception in
`wideCentralSquareLayout` (see the slide-limit comment): when the subject's
square is clamped against a frame border, the 16:9 window slides fully in-frame
(31/07 pram directive — real pixels beat a synthesized blurred band), which
walks the subject out of the canvas-middle square that every square consumer
center-crops. Each prior directive optimized ONE consumer: 31/07 the wide view
(no padding band), 08/20 the square view where slack existed. Nobody had ruled
on the frame-clamped case for the SQUARE consumer, and there the square view
delivered background.

Measured (48h, 2133 closed tracks with a thumbnail, real
`wideCentralSquareLayout` geometry): 73 tracks (3.4%) delivered a best shot
whose bbox landed <50% inside the central square — 44/191 (23%) on device 102,
19/146 (13%) on 618. Of the 73, 18 had at least one containable frame during
the track's life that the ranking discarded (it ranked confidence/edge-tier,
not delivered-square containment); 55 never had one (the subject only ever
existed at the frame's side).

Rejected first: widening the crop geometry (diagonal crop) — operator refusal,
2026-08-20. The framing stays; the FRAME CHOICE and the edge-case delivery are
what changed.

## Decision

Two rules, one threshold (`CENTRAL_SQUARE_CONTAINMENT_MIN` = 0.5, the fraction
of the subject bbox's area inside the canvas-middle square a square consumer
center-crops):

1. **Ranking.** The best-frame ranking carries a SQUARE-CONTAINMENT tier above
   even the edge-clear tier: a frame whose delivered square shows ≥50% of the
   subject ALWAYS outranks one below the line, regardless of confidence — so
   "wait for the better frame" is automatic via best-seen wherever a
   containable frame ever appears. Within the evicted tier, more-of-the-subject
   still wins (the fraction scales the effective score).
2. **Delivery fallback.** Every thumbnail delivery path (live native crop,
   raster fallback, close-time keyFrame derive) cuts with
   `deliveredWideCentralSquareLayout`: the default full-slide layout wherever
   containment holds, and ONLY when the winning frame is still below the line —
   a track whose subject only ever existed at the frame's side — the
   `containSubject` layout, which bounds the slide by the subject's real slack
   in every case. The delivered middle square is then the frame-clamped square
   itself ("the square anchored at the border"), and the residual out-of-frame
   part of the window stays lateral padding. Never the blind center.

A track is NEVER discarded for having only edge frames: a real track with
imperfect media beats no track.

## Consequences

- The 31/07 "no fill, ever" absolute is amended a second time: an edge-subject
  best shot's WIDE raster may again carry a lateral padding band — but only in
  the third that holds no subject, only when no containable frame existed in
  the whole track, and the square view in exchange always shows the subject.
- The three delivery paths must keep sharing the ONE chooser
  (`deliveredWideCentralSquareLayout`); a path that calls the raw layout
  reintroduces the empty-square case silently.
- The per-direction slack expressions in the slide limit are now load-bearing
  (they were swapped and functionally inert before — an unclamped square
  centres its subject, so the two slacks were equal; `containSubject` uses
  them exactly where they differ).
- The fallback delivery logs `best-shot delivered via contained square layout`
  with `tags: { deviceId }`.

## Enforcement

`wide-central-square-crop.spec.ts` pins the eviction fraction of the real
ec0eb76d geometry, the containSubject containment guarantee, and the chooser's
two branches. `edge-clear.spec.ts` + `best-detection-tracker.spec.ts` pin the
tier ordering (square containment > edge tier > effective score, never
decisive on a square-tier downgrade). Gate-removal was re-run RED on
2026-08-21 (7 tests fail with `isSquareContained` forced true).

## Amendment — 2026-08-21: the 0.5 line is a per-SUBJECT line, and a group needs 1.0

Measured while designing the group entity
([`2026-08-21-group-entity-and-group-media.md`](../design/2026-08-21-group-entity-and-group-media.md)),
on the real passage of 2026-08-21 19:10:09, device 102 — a woman with a pram and
a man walking together, tracks `202d3a4b…` and `3dbbcb02…`, union bbox
`{x: 485.6, y: 152.6, w: 142, h: 170.9}` in the 640×360 detection raster:

| layout | containment of the union bbox |
| --- | --- |
| default (the chooser's first branch) | **0.53** |
| `{ containSubject: true }` | **1.00** |

0.53 is *above* `CENTRAL_SQUARE_CONTAINMENT_MIN` (0.5), so
`deliveredWideCentralSquareLayout` keeps the default layout — and the delivered
square **cuts the man in half**. Rendered and looked at, not inferred: the
square shows the woman, the pram and a fragment of a second person.

The mechanism is this record's own designed case and not a defect of it: with
the subject near a frame edge the central square clamps to the border, the 16:9
canvas then slides fully inside the frame (`boundInert`), and the central square
travels away from the subject. The 0.5 line was chosen because **half of one
person is still that person** — a face, a coat, a direction of travel all
survive it, and a track is never discarded for having only edge frames.

**Half of a group is a different group.** There is no partial reading of "two
people walking together" that survives losing one of them; the picture becomes a
picture of somebody else's passage. So the threshold that is right for a subject
is wrong for a set, and the difference is in the meaning of the box, not in the
geometry.

**The amendment: a caller whose box is a UNION over several subjects requests
`{ containSubject: true }` unconditionally and never consults
`CENTRAL_SQUARE_CONTAINMENT_MIN`.** Nothing changes for the three existing
track-scoped delivery paths, which keep sharing the one chooser exactly as the
Consequences above require — the group path is a fourth caller of the same
`wideCentralSquareLayout`, with its own bound, not a second geometry (D52).

Stated as the rule to keep: **the acceptable containment is a property of what
the box MEANS. For one subject it is 0.5; for a set it is 1.0.**

Verified on the whole fleet, 72 h / 788 multi-member groups: every group union
bbox clears 0.5 under the default layout (p10 = 1.00), so the failure is a
minority edge case — which is exactly why a threshold nobody re-derives per
caller would have shipped it silently.
