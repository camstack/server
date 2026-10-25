---
id: D510
title: The subject's box travels WITH the frame, on the media row — and only a WHOLE-frame row may carry one
status: accepted
date: 2026-09-16
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-subject-shot.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/key-frame-persist.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-ai-subject-view.ts
---

## Context

The summary's AI pass sends the model a still per track. Measured on 102 the
night of 2026-09-16, every still contained a second vehicle and nothing said
which one was the subject, so the model invented the relationship between them
("passing a parked car"). The fix was to draw the subject's box on the picture
— and that immediately ran into the fact that **this system stored pictures and
boxes separately.**

The first shape shipped was a PAIRING. `TrackSnapshot` is the one record that
holds a `mediaId` and a `position.bbox` together, so `subjectShotFor` walked the
track's snapshots and took the one nearest the instant the digest wanted. It
works, and its two failure modes were counted from the first day in `summary
ai: subject framing`: a track with no snapshot at all is unboxable, and a
snapshot's instant is not the instant asked for — the nearest recorded position
measured 0.35–1.1 s away, and half a second of a car crossing a 4K frame is a
quarter of its width.

Pairing was never necessary. Every image this addon stores was cut from a frame
whose subject box was in hand at that exact instant — `captureHierarchyBodyThumbnail`
holds `bodyBbox`, `frameWidth`, `frameHeight` and drops all three; the parked
key frame's `ParkSubject` (D422) is kept beside the parcel on the hub and read
by nobody at write time. The box was thrown away and then reconstructed, badly,
hours later.

The operator put it as a question: *"perché è complicato avere le box di un
frame? Non viaggiano insieme agli eventi stessi delle tracce?"* [why is it complicated to have the boxes of a frame? Don't they travel together with the track events themselves?] They do not, and
there was no reason for it.

## Decision

**A media row carries the box of the subject that was on its frame, written at
capture — and a row may carry one only when its blob is the WHOLE frame.**

`MediaPutInput.subjectBox` (`MediaSubjectBox`: the rectangle plus the detection
frame it was measured on, stored as JSON in the `subjectBox` column) is set by
the write site, which holds the pixels and the box at the same instant. A reader
that needs "where was the subject on this picture" asks the ROW
(`listSubjectBoxesByOwner` → `resolveSubjectShot`); it pairs a snapshot only
when no row can say, which is what every row written before the column existed
will always need.

The whole-frame restriction is the load-bearing half. The box is in DETECTION
space, and a consumer maps it into the stored image through the per-axis ratio —
which is correct for any SCALE of the frame (a `keyFrameSmall` is 960×540 of a
3840×2160 frame) and wrong for a CROP. A crop's rectangle is not persisted:
`displayCrop(bbox, frameW, frameH, padding)` derives it and keeps nothing. So a
crop row stores no box, and neither does a frame that has a box and a label
already drawn into its pixels (`firstFrame`) — a picture with words in it must
not be fed to a model at all (D121).

## Consequences

- **Forward-only. There is no migration and none is possible**: a box is only
  knowable at the instant of capture, so a row written before this column
  reads as "cannot say" forever and keeps the snapshot pairing. Same shape as
  `provenance` ("NULL = written before the column existed").
- One more TEXT column on a table taking ~92 k rows/day, ~60 bytes on the rows
  that carry one and NULL on the rest. **Not indexed**: it is read by
  `(ownerKind, ownerId)`, a range `idx_media_owner` already serves, and a track
  holds a handful of rows.
- The reader no longer needs the device's CURRENT frame size to answer. That
  condition — `lastFrameDimsByDevice`, in-memory — is why a digest rendered
  after a restart could not be boxed at all; a boxed row lifts it.
- What now has to stay true: a new whole-frame write site that has the box in
  hand should pass it, and a CROP write site must not. The invariant lives in
  one docblock (`MediaSubjectBox`) and is stated at the only reader.
- **Covered today: the track `keyFrame` and its `keyFrameSmall` companion** —
  the clean best whole frame, and the image the digest tile itself comes from,
  where the box arrives free from the park's mirror. NOT covered, each for a
  stated reason: every `thumbnail` (a crop), `firstFrame`/`lastFrame` (a crop,
  or a frame already carrying a drawn box and a label), the summary group shot
  (`keyFrame` on `ownerKind: 'summary'` — its subject is a GROUP, not one box),
  the mosaic `fullFrame` (a composite of many frames) and photo-enrolment
  (`fullFrame` from an operator's upload, no track). The track `snapshot`
  filmstrip is already exact through `TrackSnapshot` and gains nothing.

## Enforcement

Tests, and they were each confirmed to fail with the rule neutralised:

- `store/__tests__/media-subject-box-over-real-sqlite.spec.ts` — the column
  round-trips through the REAL SQLite store (a fake store has no column and
  would happily return a box the table could never hold), a row without one is
  absent rather than a box at the origin, and a re-capture of the same slot
  carries the NEW box.
- `pipeline/__tests__/key-frame-subject-box.spec.ts` — the parked parcel's box
  reaches BOTH media writes, and a degenerate rectangle is refused.
- `store/__tests__/media-subject-shot.spec.ts` — the boxed row beats a snapshot
  that is NEARER in time, ties between the two encodes of one surface are
  broken deterministically, and the fallback still answers for rows with no box.

No guard script: "only a whole-frame row may carry a box" is a property of the
pixels a call site holds, which no static check can see. Review only, which is
worth writing down.
