---
id: D491
title: A vector is owned by the ROW that wrote it, not by the track it was cut from
status: accepted
date: 2026-09-13
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retention/**
---

## Context

D486 made the orphan audit reclaim through the owner, which closed the
continuous leak: a `faces` row collected by the age sweep now takes its ArcFace
vector with it. What stayed open is the case `delete-track-cascade.ts` documents
about itself — a hub that boots without the `vector-store` capability builds a
cascade with no vector leg and prunes for the life of the process — plus
whatever a maintenance window deleted in raw SQL. Neither is reachable by
ownership any more; only a walk of the index finds them.

The object-CLIP leg already walks its index. Reusing it for faces looks like a
five-line wiring and is a trap, which is why the risk was written into the
reduction plan before anyone implemented it:

* A CLIP row's id IS its track id, so `scanRefs` falls back to the id when the
  metadata is missing. A face vector's id is the FACE id and its metadata
  carries a `trackId`, because a face was cut from a track's frame. The same
  fallback would ask "is this face id a live track?", get `no` for every row,
  and empty the whole facial index.
* An ENROLLED face is exempt from retention and outlives its track by design.
  A scan keyed on the track would delete the vectors of exactly the people the
  operator registered by hand, the moment their tracks aged out — degrading
  recognition in silence, for the identities that matter most.

## Decision

The owner of an index row is whoever the WIRING says, and the scan knows only
"owner": `scanEmbeddingOrphans` takes `liveOwnerIds` and a `scope`, and each
index maps its own page onto a neutral `VectorOrphanRow`. One algorithm, two
wirings — `object-clip` owned by a track, `face-arcface` owned by its `faces`
row, probed by `FaceStore.existingFaceIds`, which throws rather than
under-reporting.

Each index keeps its own cursor in its own FIELD of the sweep-cursor row, never
an entry in the scope map: that map is assigned wholesale and would drop the key.

## Consequences

- The three protective classes come for free on the new leg: a row younger than
  the grace window is kept, a row naming no owner is unresolvable and never
  deleted, and the reclaim is verified so a delete that did nothing is reported
  as kept.
- `EmbeddingVectorIndex` gained `scan` and `dropVerified`. `drop` stays for the
  cascade, which does not need a read-back.
- A hub whose row predates the new field starts the face walk from the top.
  That costs a re-walk and nothing else.
- The enrolled-face exemption is now pinned by a test rather than by a paragraph
  in a plan.

## Enforcement

`face-vector-orphans.spec.ts`: an enrolled face whose track is long gone keeps
its vector — the test fails the moment the owner is taken from the metadata
instead of the row id (verified by mutation). The reclaim and probe-failure
paths are pinned alongside it, so "keeps everything" cannot be how it passes.
