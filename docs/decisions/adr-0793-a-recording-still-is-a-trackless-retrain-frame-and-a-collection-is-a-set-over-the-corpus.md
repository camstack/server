---
id: D793
title: A recording still is a trackless frame of the one retrain corpus, and a named collection is a set over that corpus
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-frame-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-collection-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-collection-service.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-service.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-export.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
---

## Context

The frame a detector fine-tune most needs is the person the model never
boxed. Track curation cannot reach it: there is no track, no media row and no
key frame, only the recording. The named-collections design (2026-10-03)
proposed a second ledger, `retrain-collection-frames`, holding its own copied
JPEGs under `retrain-collections/<collectionId>/…`, with annotation and export
of those frames as later follow-ons.

That shape gives the dataset two corpora. Every feature built on the first
(annotations keyed by frame, the completeness flag, the day/night flag, the
pipeline boxes, the export and its filters, a frozen dataset version of
frameIds) would need a second implementation, or would silently not see
collection frames. And a frame could not be both "a track copy" and "in the
packages-at-night collection".

## Decision

**A frame taken from the recording is a row of the one retrain frame table:
`origin: 'recording'`, no track (`trackId` absent on the wire, `''` in the
row), no source media row, `capturedAt = epochMs`, id derived from
`(deviceId, epochMs)`, bytes on the durable `retrainMedia` tenant under
`retrain/<deviceId>/recording/`. A named collection owns no pixels: it is a
membership set over retrain frames (`retrain-collection-frames`: collection,
frame), so any frame — track copy or recording still — can be in any number of
collections.**

- The still is the recorder's native frame at the instant
  (`RecordedStillService`, high profile, not downscaled), decoded on demand and
  bounded by that service's concurrency. Every refusal is named
  (`still-unavailable` with the outcome in `detail`, `still-busy`,
  `unreadable-image`, `write-failed`, `unknown-collection`).
- A recording still lives as long as some collection holds it. Removing it from
  its last collection, or deleting that collection, deletes it with its
  annotations. A track copy is never deleted by a collection.
- Deselecting a frame removes its memberships too.
- Frame-scoped methods take `trackId` as optional; when given it must be the
  frame's own. The frame is the authority for its camera and track.
- The export manifest is `camstack.retrain-export/v3`: `origin`, `epochMs`,
  `collectionIds` per frame, `trackId` absent on a recording still, and the
  filter `collectionIds`.

## Consequences

- One annotation, completeness, pipeline-box and export path for both origins.
  A dataset version (a frozen frameIds list) can mix them.
- Readers that assumed every frame has a track must accept its absence: the
  admin page, the export consumer (v3), any trainer splitting by track (a
  recording still splits by camera and day).
- The 2026-10-03 design's separate copy prefix and ledger are not built.

## Enforcement

`retrain-recording-still.spec.ts` (trackless copy, durable path, one copy per
moment, refusal writes nothing), `retrain-collections.spec.ts` (names,
membership, delete), `retrain-collection-service.spec.ts` (every still
outcome named, orphan stills deleted, track copies kept, trackless annotate /
complete / deselect) and `retrain-export-recording.spec.ts` (v3 manifest,
collection filter, URL round trip).
