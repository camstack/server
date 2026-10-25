---
id: D654
title: A "Full frame" notification is the CLEAN scene — every boxed timeline tile has a clean twin, and an annotated fallback is reported per camera
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/services/event-media-dispatcher.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
---

## Context

A notification rule's image option "Full frame" (`media.frame: 'full'`) is
described to the operator as the scene with no annotation, and "Full frame with
boxes" (`'boxed'`) as the annotated one. The operator reported that "Full frame"
arrives with the detection box burned in.

It had been measured on 2026-08-25: of 38 `frame:'full'` deliveries whose bytes
were sha256-matched back to stored media, 19 (50%) were `firstFrame` /
`snapshot` / `lastFrame` — the timeline tiles `boxedTimelineFrame` draws the
track's own box onto. The `full`/track ladder ends with those three because the
still is gated on the trigger instant first (±2 s, D225) and they were the only
DENSELY written whole-scene kinds; `keyFrame` / `keyFrameSmall` are one
best-detection instant per track.

Tried first, and refused on evidence: deleting the annotated tail. Over 60 real
deliveries 46.7% held ONLY an annotated tile in band, so a strict ladder took
the picture away from about half of them instead of cleaning it, and left D225
and the zone narrowing (D223) with nothing to choose between. Tried second
(2026-09-03): a clean twin of the tile, `sceneFrame` — it worked live and was
withdrawn the same day so the best-shot change could be tried alone. The boxed
deliveries persisted.

## Decision

Every boxed timeline tile is written with a CLEAN twin (`sceneFrame`), encoded
from the same decoded surface in the same write — one extra encode, no second
fetch, and the twin is written BEFORE its tile so no reader ever sees a boxed
instant without its clean one. An appended tile (`firstFrame`, `snapshot`) gets
an appended `sceneFrame`; the rolling `lastFrame` gets the SINGLE-INSTANCE
`lastSceneFrame`, so a roll is one blob overwrite plus one upsert. The `full` and `keyFrame` ladders ask for every clean kind
(`keyFrame`, `keyFrameSmall`, `sceneFrame`) before any annotated one; `boxed`
keeps asking for the annotated kinds first. The annotated tile stays as the
documented LAST rung of a clean ask — for tracks that hold no clean frame at all
— and every delivery that reaches it logs `clean scene asked — only an annotated
frame is stored, shipping it` with `tags: { deviceId }`, the kind and the ask.
It is never shipped silently as "full frame".

## Consequences

- Storage: about **+2 JPEGs per track, 100–180 KB each** (the birth
  `sceneFrame` and the one `lastSceneFrame`), plus one `sceneFrame` per debug
  `snapshot` (debug media only). Track-owned, so it ages out with the track
  (D161).
- Write load: a roll (every 2 s per live track) costs one extra blob write and
  one upsert on `sqlite-settings`. The first cut appended a row per roll and
  deleted the previous one by id — a put, a get, an unlink and an index delete
  on top, on the synchronous thread D447 protects; the single-instance kind
  removed all of them.
- Why a second kind rather than making `sceneFrame` single-instance: the birth
  twin is the trigger-instant clean frame of a doorstep rule, and a
  single-instance `sceneFrame` would be overwritten by the first roll 2 s later.
  `lastSceneFrame` is new in `MediaFileKindEnum`; cap outputs pass through the
  hub unvalidated (`cap-router-builder.ts`), so an older server closure does not
  reject it.
- A twin write never gates its tile: a failed twin is a WARN per camera and the
  tile's own write and landed-reporting are unchanged.
- `sceneFrame` is NOT in `CLEAN_SCENE_KINDS`: that list also feeds the AI
  narration pool, where a twin would spend a second frame on the same instant.
  The ladders name it explicitly through `SCENE_TWIN_KIND`.
- A fixed-path file is replaced WHOLE: both media writers (the framework
  `FilesystemStorageProvider` and the addon's location-aware router) write a
  dot-prefixed temp beside the target and `rename` it over, so a notification
  reading `lastSceneFrame` or `lastFrame` while the next roll lands gets the old
  complete file or the new one, never a prefix. The blob is still written
  before the row upsert, so a row can briefly point at the NEXT roll's bytes
  under the previous timestamp — both whole, one roll (2 s) apart. The cost is
  one `rename` per write, a metadata operation independent of the payload. The
  callers of those writers are `MediaStore` (event media), `RetrainFrameStore` (retrain copies) and the relocate engine — all in `addon-post-analysis`. Recordings are not among
  them (ffmpeg writes segments directly), nor are HKSV clips (`clip-store.ts`
  has its own write-and-rename). On Windows a rename over an open file is
  retried and then falls back to a copy.
- When it is live: the addon's preset (`self-contained+ui`) bundles EVERY
  `@camstack/types/*` subpath (`SELF_CONTAINED_EXTERNALS` omits
  `BARE_TYPES_EXTERNAL`), so the addon imports `writeFileAtomic` from
  `@camstack/types/node` and inlines it. Routed-location writes and the
  `CAMSTACK_MEDIA_ROOT` provider (constructed in the addon from the bundled
  `FilesystemStorageProvider`) are atomic on addon deploy. Only the
  `ctx.kernel.storage` default — the provider the RUNNER builds
  (`addon-runner.ts:284`) — waits for a `@camstack/server` release carrying
  this `@camstack/types`.
- Clients that list track media see `sceneFrame` / `lastSceneFrame` rows. The
  admin labels them and draws the trail on them; the viewer's detail gallery
  shows an unknown kind as its own tile until it gives the kind a rule.
- Retrain anchors on the clean twins, and no longer on `firstFrame` /
  `lastFrame` / `snapshot`, which `RETRAIN_FRAME_KINDS` had wrongly called
  unannotated.
- Ship order: `addon-post-analysis` alone carries the fix. Its vite preset is
  `self-contained+ui`, whose externals are the runtime set plus
  `@camstack/system` and `ui-library` — bare `@camstack/types` is BUNDLED into
  the addon dist (its entries import no `@camstack/types`), so the new kind and
  the clip-default constants are live on deploy without a server release.
- Tracks written before this lands hold no twin: their `full` deliveries take
  the reported fallback until retention ages them out.

## Enforcement

- `event-media-dispatcher-scene-twin.spec.ts` asserts the twin is BYTE-EQUAL to
  the clean encode of the tile's surface (a twin that carried the box fails),
  that the rolling twin is the single-instance `lastSceneFrame` (one store
  write per roll, nothing read or deleted), that every twin — birth, snapshot,
  rolling — is written before its tile, and that a failed twin costs the tile
  nothing.
- `atomic-write.spec.ts` (types) and the
  provider and router specs assert a concurrent read never sees a torn file.
- `frame-preference.spec.ts` asserts the `full` ladder ranks every clean kind
  above every annotated one, that `frame:'full'` ships the twin over the tile of
  the same instant, that `boxed` still ships the tile, and that the annotated
  fallback is reported once per RECORD (not per target or retry) with
  `tags: { deviceId }`.
- The birth twin is asserted to be written before its tile, and a roll to issue
  exactly one store write for its twin; the store fake is typed to the two
  operations the dispatcher may call.
- Nothing checks the live ratio; the sha256 join described in
  (planning repo: sessions/sessions.md) (2026-08-25) is how to re-measure it. <!-- drift-ok: moved to the private planning repo -->
