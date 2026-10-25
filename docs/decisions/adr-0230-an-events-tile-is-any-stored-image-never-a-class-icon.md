---
id: D230
title: An Events tile is any stored image, never a class icon beside one
status: accepted
date: 2026-08-24
supersedes: D229
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/event-thumbnail-resolver.ts
  - packages/addon-post-analysis/src/pipeline-analytics/ensure-track-hierarchy.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts
  - packages/addon-post-analysis/src/pipeline-analytics/plate-recognizer.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/short-motionless.ts
---

## Context

D229 made a crop-forced Events tile (`?kind=thumbnailSmall` / `?kind=crop`)
404 when the track had no subject crop, so a native `keyFrame` would not
paint the whole camera. The operator rule that actually holds is the
opposite: **never show the class icon while any image exists**. A parking-lot
keyFrame is worse than a person crop and better than an empty tile
(`20da3195`, `86918072` on 102).

The 404 also hid a deeper invariant break. Face and plate crops use
`captureDisplayCrop` (native **or** retained/RAM full-frame). Track
`thumbnail` and `keyFrame` are native-strict: a RAM-tier surface is a miss.
So a face can persist under `ownerKind: 'face'` while the track owns ZERO
media (`0e343f86` on 103, `9310d1ff` on 104). A face without a person crop
and a full frame is not a complete subject; a plate without a vehicle crop
and a full frame is the same hole.

D229 also raised `MOTIONLESS_MAX_PX` 8 → 40 so a standing person (9310d1ff:
9.7 s, 30 px net) stamps `stationary-promotion`. That ceiling on a
**vehicle** hides a real car whose Events path and crop were the car
(86918072: 10.9 s, net 15 px, walk 435). The two were grouped only as the
same missing-thumbnail picker bug — 86918072 was never a person.

Rejected: keep 404 as the honest miss. The operator cannot tell "pipeline
dropped the crop" from "this card is empty on purpose", and a face-bearing
track with a keyFrame in store still showed an icon.

## Decision

A crop-forced request serves, in order: the body crop (`crop` / `thumbnail` /
`thumbnailSmall` on the event or track) → a tight face/plate crop → any
remaining image (`keyFrameSmall` / `keyFrame` / `fullFrame` / `lastFrame` /
…). The class icon is only for a total miss.

When a face or plate crop lands from a still-live handle, the same handle
must also fill the missing parent rungs: body thumbnail via
`captureDisplayCrop` (the surface that produced the detail, not
native-strict) and native `keyFrame`. A tight face JPEG is not a person
crop; copying it onto the track remains a last-resort tile, not the
hierarchy.

Short-motionless hide is class-specific: person (and other non-vehicles)
net ≤ 40 px; `vehicle` / `car` / `truck` / `bus` stay at 8 px.

The close-path half of D229 still holds: derive the thumbnail against the
keyFrame's own timestamp, and spend the retained raster if derive still
misses.

## Consequences

- Existing rows that already have a keyFrame and no thumbnail start showing
  the keyFrame immediately (serve-path). Face-only rows show the face crop
  until a body thumbnail exists.
- New face/plate captures while the handle is live dispatch the parent
  media; closed rows are not rewritten.
- A parked-plate flash still hides. A short vehicle with 15 px net does not.

## Enforcement

`event-thumbnail-resolver.spec.ts` (any-image fallback, face/plate layers).
`ensure-track-hierarchy.spec.ts`. Face/plate recognizer specs fire
`onLiveHierarchy` with the body bbox. `short-motionless.spec.ts` pins
86918072 vs 9310d1ff. Review only for the `index.ts` capture wiring.
