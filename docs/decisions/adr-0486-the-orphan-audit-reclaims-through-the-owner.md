---
id: D486
title: The orphan audit reclaims through whatever OWNS the row, and no collection gets a default
status: accepted
date: 2026-09-13
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-reclaimers.ts
---

## Context

Measuring the database after the maintenance wipe, rather than working from the
plan, put `vec_object_clip_vector_chunks00` at 82 MB — 29 471 vectors against 22
live tracks. That turned out NOT to be a code defect: `object-clip` is one row
per track, the cascade deletes it, and `embedding-orphan-scan.ts` already walks
the index in `reclaim` mode every six hours. Those orphans came from
`wipe.sql`, which deleted tracks in SQL and bypassed the cascade, and they clear
themselves at the configured pace.

The defect was one layer down, and the vector table is what made it visible.

The audit's reclaim was one `if` for media and a raw `settingsStore.delete` for
everything else. `FaceStore.delete` is `store.delete` **followed by**
`vectors.drop([faceId])`. So every orphaned `faces` row the sweep collected left
its ArcFace vector behind — in an index whose rows are reachable only by that
face's id, walked by no sweep at all. 2 568 vectors, 20 MB, in
`vec_face_arcface_vector_chunks00`.

Nothing looked wrong because the raw delete really did delete the row it was
asked about. It is the same shape the media branch was already hardened
against — a reclaim that "turns an orphan into bytes nothing names, which is
strictly worse than the state it was cleaning up" — one layer over, and with no
file on a disk to give it away.

## Decision

The audit reclaims a row through the code that OWNS it. `faces` goes through
`FaceStore.delete`; `media` through `MediaStore.deleteConfirmed`; a collection
whose store owns nothing beyond the row takes the plain delete, and says so.

There is **no default**. A collection the audit walks and `RECLAIMED_COLLECTIONS`
does not name throws, because the failure this record is about is not really
about faces: a raw-delete default silently hands the broken path to whatever
collection is added next, and the only evidence is bytes in a table nobody
thought to measure.

## Consequences

- Adding an auditable collection now costs one line and one decision. That is
  the point: the decision was previously made by omission.
- `bytes` stays `null` for a face reclaim. The row has no blob to weigh and the
  vector it also freed lives in another store with no byte answer here —
  claiming a number would make `bytesReclaimed` a guess, and D480 made that
  figure honest on purpose.
- `face-arcface` still has no orphan scan of its own. With this fix the vectors
  leave with their rows, so the ongoing leak is closed; what remains uncovered
  is the case `delete-track-cascade.ts` documents itself — a hub that boots
  without the `vector-store` capability prunes tracks with an embedding-less
  cascade for the life of the process.

  **Whoever writes that scan must not copy `object-clip`'s `scanRefs`.** Two
  reasons, the second serious. In `object-clip` the row id IS the trackId and
  the scan falls back to it when metadata is missing; a face row's id is the
  **faceId**, so that fallback would ask "is this faceId a live track", answer
  no for every row, and delete the entire index. And an ENROLLED face is
  retention-exempt through an `assigned` column on the ROW, which the vector's
  metadata does not carry — a track-based predicate would delete the vectors of
  exactly the people the operator enrolled by hand, degrading recognition
  silently. The correct question is "does the `faces` row still exist": the
  vector is owned by the row, not by the track.

## Enforcement

`scripts/check-orphan-reclaimers.ts` (wired into CI) compares
`auditableCollections()` with `RECLAIMED_COLLECTIONS` in both directions — an
audited collection with no reclaimer would otherwise throw six hours into a
sweep, at night, on a hub. Verified by removing `faces` from the map and
watching it fail.

`orphan-reclaimers.spec.ts` pins that a face reclaim goes through the store and
NOT through the raw path, that a media key which is not a rowid keeps its row,
and that an undeclared collection throws rather than guessing.
