---
id: D644
title: Every buffered face keeps the full frame it came from, and the gallery restarts from a core of three per identity
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/face-gallery-reset.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-template-realign.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-source-frame.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-source-window.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/face-source-park-port.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-alignment-jobs.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-gallery-provider.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-source-stats.ts
  - packages/addon-pipeline/src/pipeline-runner/detail-subtree.ts
  - packages/addon-pipeline/src/session-decode/parked-frame-store.ts
---

## Context

After D643 the gallery held 527 samples cut by two alignments. The 518
DETECTED ones kept only their 112×112 template: the frame each face came from
had gone with footage retention, so none of them could be re-derived through
the fixed SCRFD. The operator decided, on 2026-09-26: keep the three best
samples per person, discard everything else (pending faces included), and from
now on keep the original frame of every face.

What was tried first, for the samples that have no original: re-align FROM
the stored template. The detector finds no face on a raw template, so it is
upscaled and letterboxed and run through the real photo analyze path.
Measured read-only on the live hub:

- On the nine v2 photo templates, re-aligning a template against its own
  direct embedding gives cosine 0.88–0.97. That is the method's own error.
- There are eight same-instant pairs: an enrolled v1 template whose source
  keyFrame still exists. The ground truth is the new-aligned embedding of the
  face on that keyFrame. The re-aligned template reaches cosine 0.83 on
  average (0.76–0.89). The untouched v1 template reaches 0.65.

Re-aligning is better than keeping the template as it is. It is still under
the 0.85 the operator set as good.

The first cut of the source frame (reviewed before release) parked a native
frame on EVERY new best face, into the runner's shared 64 MB parcel store,
where a full budget evicts the globally oldest parcel — a track's `keyFrame`
could be pushed out by a face parcel (D58). It also shared one frame between
faces of the same instant, which saved 3 of 1 606 frames and cost an
ownership graph with a loss path. Both were changed before release.

## Decision

**Reset.** `faceGallery.resetToCore` (admin custom action on
`pipeline-analytics`) keeps `keepPerIdentity` (default 3) samples per
identity: photo v2, then detected v2, then photo v1, then detected v1; within
a tier, the sample closest to the identity centroid. Everything else goes
through the operator's Remove path, which detaches the buffered faces that
named a removed sample. Pending faces — unassigned and naming no identity,
suggested ones included — are deleted with their media, each after a
re-check of that predicate right before the delete; only deletions that
happened are counted. Faces that carry an identity stay.

Re-alignment of v1 detected picks runs with `realignDetected: true`:

- a replacement is added and read back before anything of that identity is
  removed, and it names the v1 sample it replaces (`replacesSampleId`), so a
  rerun after a crash finishes the removal and never re-aligns that template
  again;
- a refused, unwritable or unverified replacement keeps its old sample;
- an identity whose kept set does not read back is skipped, never emptied;
- the gallery refresh runs in a `finally`, so a run that throws midway still
  leaves the matcher on what landed.

The reset refuses while a photo pass, a re-embed, a prune, a photo-source
backfill or another reset runs, and the backfill refuses while a reset runs.

**Source frame.** Behind `keepSourceFrames` (face settings, default OFF).
When a face becomes its track's held best — at most once per 2 s per track —
the hub either references the track's own `keyFrame` when that parcel shows
the same instant, or orders the owning node to park the frame (D422, key
`face-src:<trackId>`, the native `keyFrame` cap). On the runner, `face-src:`
parcels live in their OWN store (16 MB per node, 4 per camera): a face
parcel can only ever evict another face parcel. Only when the face is
buffered is the parcel fetched, checked to show the parked instant, and
stored as a `face`-owned `fullFrame` — one frame per face. The face row names
it with the box and the five landmarks scaled onto it. The frame kept is the
LAST PARKED best face, at most 2 s older than the held one.

Enrolment re-owns the face's own frame to the identity as the sample's
`sourceMediaId` (with `sourceBbox`, `sourceLandmarks`); a referenced track
keyFrame is copied instead, and the face points at the copy. Removing the
sample deletes the frame and detaches the face; unassigning gives the frame
back, and a frame that cannot come back is deleted rather than left
identity-owned and unreferenced. `faceGallery.sourceFrameStats` reports, per
camera: parks per track, park round-trip ms (the runner's encode plus one
RPC), keyFrame reuses, stored frames and bytes, and every drop by reason.

The photo re-enrol pass also re-derives detected samples that name a source.
For now it analyses a window 4× the face's long side cut ON THE HUB and sent
through the photo path. That is **not** the live detail path: the live plane
has the runner derive the crop around the PERSON (D52). So "re-derive
exactly" holds for the alignment (landmark-driven warp) but not for the
detector's input framing; the path is to move to `runDetailSubtree({ frameJpeg })`
on the runner, which is a later change.

## Consequences

- **Storage.** A frame is ~1.64 MB (the live `keyFrame` average; same parcel
  type). At 270–450 buffered faces a day: 0.45–0.75 GB/day, minus keyFrame
  reuses. Bound on face-owned frames: the unassigned buffer's row cap —
  `bufferMaxPerDevice` (50) + the suggested budget (200) per camera, ~9.4 GB
  for 23 cameras, 2.9 GB at today's 1 767 rows — and they leave with their
  face and track. Enrolled frames (`galleryMedia`, exempt from sweeps) are
  bounded by the sample count, one frame per detected sample: they leave with
  the sample (Remove, the D643 prune, the reset). No separate per-identity
  frame cap: a cap below the sample count would strand samples without their
  source, which is what this record exists to end. At today's post-reset
  gallery (12 samples) that is < 20 MB, growing 1.64 MB per enrolment.
- **Runner memory.** Face parcels: ≤ 16 MB per node on top of the unchanged
  64 MB track budget.
- **Resolution: native.** A 28 px face downscaled to 1920 wide is ~14 px,
  under the 24 px landmark floor.
- **Landmarks** ride the new optional `DetailResult.landmarks`: they need
  `addon-pipeline` deployed and a `@camstack/server` carrying the widened
  schema; until then frames are stored with the box only.
- **Losses, all logged and counted** (`buffered WITHOUT its source frame`):
  parcel evicted or aged out (10 min), park refused, track keyFrame moved to
  another instant after it was referenced.

## Enforcement

Tests pin each rule, and each gate was disarmed once:

- `face-gallery-reset.spec.ts`: selection order, centroid rank,
  add-then-remove, refused/unwritable/unverified replacement, never zero,
  dry run, pending, idempotence, refresh in `finally`, crash recovery (full
  and partial).
- `face-gallery-reset-jobs.spec.ts` (real stores): detach not delete,
  history kept, pending deleted with media, the pending re-check, uncounted
  failed deletes, every refusal including backfill ↔ reset.
- `face-source-frame.spec.ts`: setting OFF by default, the park interval,
  one frame per face, wrong-instant refusal, keyFrame reuse and the moved
  keyFrame, dropped faces move nothing, release on close, stats.
- `face-source-enrol.spec.ts` (real stores): the move into the sample,
  delete + detach, unassign return, no leak when it cannot return, keyFrame
  copied not taken, foreign frames not enrolled, the track cascade.
- `parked-frame-store-face-source.spec.ts` (runner): face parcels at their
  cap never evict a track parcel.
- `face-source-park-port.spec.ts`, `face-photo-reenrol-pass.spec.ts`,
  `face-source-reenrol-jobs.spec.ts`, `detail-landmarks.spec.ts`.
