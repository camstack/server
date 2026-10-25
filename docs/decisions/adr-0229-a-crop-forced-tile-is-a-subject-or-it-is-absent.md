---
id: D229
title: A crop-forced Events tile is a subject crop, or it is absent
status: superseded
superseded-by: D230
date: 2026-08-24
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/event-thumbnail-resolver.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-close.ts
  - packages/addon-post-analysis/src/pipeline-analytics/copy-face-crop-preview.ts
---

## Context

Events gallery tiles request `?kind=thumbnailSmall` (embed) or `?kind=crop`
(older reel). When the track had a native `keyFrame` but no `thumbnail`,
`pickCleanMedia` treated `keyFrame` / `fullFrame` as CLEAN and
`resolveCropForcedMedia` then fell through to `lastFrame`. The tile painted
the whole camera. Live 2026-08-24: `20da3195` and `86918072` on device 102.

That fallback was deliberate — "a boxed preview beats an empty tile" — and it
hid the close-path miss: `maybeDeriveThumbnailFromKeyFrame` passed the latest
`bestSeen.timestamp` into `createKeyFrameCrop` (`maxSkewMs = 1500`). The
keyFrame is often the birth frame; best-seen keeps moving; skew rejects the
crop; `hasBestMedia` is true because a keyFrame exists, so the retained
raster is never committed either.

Rejected: keep serving the full scene so the card is never empty. The operator
cannot tell a missed crop from a wide shot of the garden, and the close path
stops being forced to land a real tile.

## Decision

A crop-forced request (`preferKind` set) serves a subject crop (`crop` /
`thumbnail` / `thumbnailSmall`) or 404s. It never invents a tile from
`keyFrame` / `fullFrame` / `lastFrame`. An *explicit* `?kind=keyFrame` or
`?kind=snapshot` still matches exactly (videoclips). The close path must land
the crop: derive against the keyFrame's own timestamp, spend the retained
raster if derive still misses, and copy a persisted face crop onto the track
when the track has no thumbnail of its own.

## Consequences

- A tile with no subject crop shows the class icon. That is the honest miss.
- Face rows (`ownerKind: 'face'`) are not track media; `hasEmbeddedFace` is
  not a thumbnail. The copy runs after the face crop `put`, best-effort.
- Notification-center stills keep their own ladder (`keyFrameSmall` first).
  This rule is the Events HTTP tile, not every media consumer.

## Enforcement

`pick-clean-media.spec.ts` and `event-thumbnail-resolver.spec.ts` refuse
full-scene fallback. `track-close.spec.ts` pins keyFrame-instant derive and
raster-after-failed-derive. `copy-face-crop-preview.spec.ts` pins the face
copy. Review only for the close-path wiring in `index.ts`.
