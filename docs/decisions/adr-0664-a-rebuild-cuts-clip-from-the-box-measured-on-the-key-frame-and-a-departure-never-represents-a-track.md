---
id: D664
title: A CLIP rebuild cuts from the box measured on the key frame itself, and a box-less event never represents a track
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/rebuild-source-loader.ts
  - packages/addon-post-analysis/src/pipeline-analytics/embedding-rebuild.ts
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts
---

## Context

The CLIP re-embed pass (`rebuildObjectEmbeddings`) is how history migrates to
a new model — here SigLIP2. Run on 2026-09-27 it refused most of the fleet as
`missingBbox`, and the vectors it did write were cut off the subject.

Two defects, one feeding the other:

1. **`bestEventId` pointed at a departure.** Since 2026-09-07 a `state:'left'`
   object event carries NO bbox (D393: absent, never a fabricated
   `{0,0,0,0}`). `EventStore.peakForTrack` skipped zero-area rows but kept
   box-less ones eligible "for legacy rows", and `left` is activity tier, so it
   outranked `entered` and became the `bestEventId` of most tracks.
2. **The rebuild took its box from that event**, not from the key frame it
   cuts. Even where the event had a box it was measured on a different frame:
   against the key frame's own `subjectBox` (D510) the median IoU was 0.50,
   and 6 of 36 were under 0.1 — the crop left the subject. That is the
   cross-frame cut D303 forbids.

Scale on the live hub: 42,254 tracks, of which 6,726 audio and 180 sensor
(never embeddable: no object event); 36,452 key frames, 30,628 with a
`subjectBox`, 5,824 older ones (before 2026-09-16T12:32Z) of which ~86% have a
track position at exactly the key frame's timestamp. The status also added
`missingEvent` (audio/sensor) into `missingKeyFrame`, so the media-coverage
number read thousands too high. And the ~111 SigLIP2 vectors that pass did
write were in-space, so every later pass would skip them as done.

## Decision

**The rebuild cuts from a box measured on the pixels it cuts, and says which
rule placed it.** In order: the key frame row's own `subjectBox`, read off the
index row (`listSubjectBoxesByOwner`, no image read), normalised by that row's
frame size, with the key frame's timestamp; for a key frame without one, the
track position at EXACTLY the key frame's timestamp (never the nearest); the
best event's box only when there is no key frame row at all, because the
pixels can then only be a recording re-decode at the event's instant; otherwise
a named refusal (`no-position-at-key-frame`, `track-frame-size-unknown`,
`track-row-missing`, `event-without-box`) decided before any blob read or
recording decode. Each rule is counted in the status (`boxSource`), and a
refusal logs tagged `{ deviceId }` — first per camera, then every 100th.

**A row that did not measure the subject never represents a track.**
`peakForTrack` skips box-less rows as it already skipped zero-area ones, for
both `bestEventId` and the importance peak.

Around them: the rebuild listing excludes `audio`/`sensor` tracks
(`REBUILD_EXCLUDED_SOURCES`); `missingEvent` is reported on its own field; and
`force: true` (admin, requires `maxTracks`) re-embeds ONLY tracks already in
the target space, to redo vectors cut from the wrong box.

## Consequences

- **Importance rises back to its pre-2026-09-07 level.** When a box-less departure won the confidence peak, the area term (`peakBboxAreaFrac`) was 0; it now comes from a measured row and adds up to 0.12 importance. More new tracks will pass `minImportance` notification rules and key-event thresholds. It is a correction, not a regression — watch the notification volume for a day after deploy.
- **Deploy order:** addon-post-analysis first (every node), then the `@camstack/server` carrying the new status fields; a new server over the old addon fails `getObjectEmbeddingRebuildStatus` output validation.

What changes for each `bestEventId` consumer:

- **Track close** (`track-close.ts` → `setImportance`, the `track.lifecycle`
  end payload's `media.bestEventId`): new tracks now point at a crop-bearing
  event instead of the departure. A track whose only events are box-less gets
  no `bestEventId`, and its events are not importance-stamped.
- **Importance**: departure rows no longer feed `peakConfidence` /
  `peakBboxAreaFrac`. A departure's confidence is the stale last-real score, so
  the peak moves only where that copy exceeded every measured row.
- **`recomputeTrackImportance` and `getKeyEvents` / `rankKeyEvents`** prefer the
  STORED pointer (`track.bestEventId ?? peak`). History keeps its departure
  pointers — nothing rewrites them. Only rows with no stored pointer, and every
  new track, get the fixed choice. `KeyEvent.id` still falls back to the trackId.
- **Viewer / admin UI** (`TrackDetailView`, `TrackCropImage`,
  `EventDetailPanel`) resolve media and the event row by `bestEventId`. For new
  tracks that id now names an event with a box and a crop, so the event-owned
  crop resolves instead of falling through.
- **The rebuild** calls `peakForTrack` itself, so it gets the fixed choice
  across all history. It uses it only for class, confidence and camera, plus
  the box of a track that has no key frame.

The **live path** was checked and cuts CLIP from the right box: every rung of
`TrackDetailDispatcher.runOnce` pairs its pixels with that same frame's box — a
frame handle with the box from that frame, the parked key frame with the box
in the parcel's own space, and the pre-cut tile from that frame. A coasted box
is never media (D397).

Still open: the stored departure pointers on history rows. A backfill would
be a re-derivation over stored events, and D54 covers it.

## Enforcement

Tests, each disarmed once: `rebuild-source-loader.spec.ts` (subjectBox wins,
the positions fallback requires an exact timestamp, a stored key frame never
takes the event box, named refusals come before the blob);
`rebuild-box-source.spec.ts` (a refused box pays no recording decode, the
per-rule counts, the per-camera log throttle, `force` selects in-space tracks
only and is bounded, the page query excludes audio/sensor);
`key-event-store.spec.ts` ("entered with box, left without box → bestEventId =
entered"). There is no guard script.
