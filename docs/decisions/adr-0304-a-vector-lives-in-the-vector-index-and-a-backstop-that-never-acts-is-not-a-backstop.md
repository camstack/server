---
id: D304
title: "A vector lives in the vector index; a reconcile ENUMERATES; and a backstop that never acts is not a backstop"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/types/src/capabilities/vector-store.cap.ts
  - packages/system/src/builtins/sqlite-storage/vector-index-vec.ts
  - packages/system/src/builtins/sqlite-storage/vector-index-shared.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/embedding-vector-index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/embedding-json-conversion.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/object-embedding-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/embedding-orphan-scan.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit-settings.ts
---

## Context

`vector-store.cap.ts` opened with the claim that **six** stores in
`addon-post-analysis` held their vectors in a `JSON` settings-store column and
that the capability existed to fix that. One migrated (`object-clip`,
2026-08-06) and the sentence was never revisited. Counted column by column on
2026-08-30, **three** stores ever held a vector: `object-clip`,
`faces.embedding` and `identity-samples.embedding`. `plates` and
`vehicle-samples` hold a plate STRING and a score; `vehicles` and `identities`
hold a name; the event store holds no derivative vector. Five of the six were
never candidates, so the docblock read as five pieces of pending work that did
not exist — and the two that WERE pending looked like part of a queue rather
than the whole of it.

The cost of leaving them in JSON was measured the same morning: 10 767 B of
JSON text per 512-dim vector against 2 732 B as base64, 17.5 MB in `faces` and
1.4 MB in `identity-samples`; and, larger, a read cost — `listAllRecentFaces`
pages **1 000 full rows at a time** to answer an Unassigned-Faces poll on a 30 s
interval whose output schema has no embedding field at all. Roughly 11 MB of
floats parsed and discarded every 30 seconds per open tab. Bytes are not the
argument; **JSON text cannot be searched** is.

Alongside it, the `object-clip` index held ~22 128 vectors against 16 693 track
rows, with **≈9 000 (36–45%) orphaned** — vectors whose track is gone, which can
neither be re-embedded (`loadRebuildSource` needs the track's `keyFrame` and its
best object event; both left with the track) nor returned
(`searchObjectEvents` joins every ranked hit back to an `ObjectEvent` by
`trackId` and drops what it cannot resolve). Two independent defects kept them,
both visible in production logs:

```
analytics orphan audit {"examined":4096,"orphans":956,"reclaimed":0}
sqlite-vec: topK clamped {"index":"object-clip","requested":20000,"k":4096}
```

1. **The audit enumerated the index with a KNN.** `EMBEDDING_ORPHAN_SCAN_LIMIT`
   is 20 000; it reached the index as a `topK`, which sqlite-vec clamps to
   `VEC_KNN_MAX_K = 4096`. The clamp WARNED — in the provider's log, not in its
   answer — so the audit consumed 18.5% of the index and reported
   `examined: 4096` as if it had walked it. Worse, the probe vector was
   `new Float32Array(512)`: a zero vector has no direction, so the 4 096 rows it
   did see were not a sample of anything.
2. **`orphanAuditMode` defaulted to `'report'`**, so the 956 it did find were
   never reclaimed. Not once, since the engine shipped.

And underneath both, the leak the backstop exists to catch. The cascade's
vector leg (`ObjectEmbeddingStore.deleteByTracks`) swallowed a throw, returned
`rows: 0`, and the cascade then deleted the track ROOT anyway — so a vector that
did not leave could never be found by ownership again. This is not
hypothetical: the store's own docblock records a live incident where a
`vector-store` provider swap left every call throwing `index "object-clip" was
never declared` **for hours**, while retention kept deleting tracks underneath.
Separately, `buildAnalyticsCascadeRegistry` omits any optional leg that is not
bound — silently — so a hub that booted without the vector store pruned tracks
with an embedding-less cascade for the life of the process.

## Decision

Four rules.

**1. A vector lives in a vector index, and one index answers ONE question.**
`faces.embedding` and `identity-samples.embedding` move into `face-arcface` and
`identity-arcface`. They hold the same 512 ArcFace dims from the same model and
they still get two indexes, because an index is a set of rows that are ranked
against each other and that live and die together: a `faces` row is TRACK-OWNED,
cascades with its track and is capped per camera (a candidate); an
`identity-samples` row is retention-EXEMPT forever (the answer every candidate
is measured against). Merged, every gallery load and every reconcile would carry
a discriminating filter whose two failure modes are "a face ranked against
itself" and "an enrolled person's only sample reclaimed as a track orphan". A
shared dimension is not a reason to share an index.

**2. Existing rows are TRANSFORMED IN PLACE, and the JSON is not blanked until
the index write is CONFIRMED.** No version table, no replayable steps: a row is
converted when its `embedding` column holds `[]` and its vector is in the index,
and that state is reached by doing the work or by having been written after this
shipped. Re-running finds nothing to do. Until a row is converted, every reader
falls back to its JSON column and SAYS SO — recognition works through the
conversion, not across a gap in it.

**3. A reconcile ENUMERATES; it does not rank.** `vectorStore.scan` returns one
cursored page of an index in a stable order, computes no distance, and has no
`k` ceiling. Nothing may enumerate an index through `query`. Where a ranked
search genuinely hits the backend's ceiling, the caller learns the NUMBER:
`VectorQueryResultSchema.effectiveTopK` is the `topK` the backend actually ran
with, in the answer, not in a log line in another process.

**4. `orphanAuditMode` defaults to `'reclaim'`.** The report-first default was
correct for exactly as long as its stated premise held — *"this engine's
correctness rests entirely on an ownership model that is being rewritten in the
same change"*. That premise is spent: the model has run in production for weeks
and been read (the `faces` scope's 99 orphans among its oldest 300 rows were
all `assigned`, i.e. the exemption working; the vector index's 956 per pass are
all D58-clean). What report mode had left to prove, it proved; what it did
instead was nothing, forever.

And the cascade rules that make the backstop's job finite: **the vector leg
VERIFIES its delete** (`deleteVerified` reads the ids back through `getByIds`
and reports what survived), and **an omitted cascade leg is NAMED in a log line
at every registry build**.

## Consequences

- **A destructive default now ships.** An upgraded hub starts reclaiming on its
  next audit tick. The blast radius is unchanged and bounded five ways (exempt
  owner kinds, the grace window, probe-failure abandons the scope, an
  unresolvable row is kept, a per-scope reclaim ceiling visible as `stoppedBy`),
  and an operator who wants the old behaviour sets `orphanAuditMode: 'report'`.
  An OPERATOR-triggered pass (`retention.orphanAudit`) is still dry-run unless
  it names `mode`; that did not change.
- **`Face` and `IdentitySample` no longer carry an `embedding` field.** Removing
  it rather than leaving it empty is the point: an empty array is a value a
  clustering pass silently treats as "nothing to cluster". A caller that needs
  floats asks for them by name (`getWithEmbedding`, `loadEmbeddings`,
  `loadGallery`), and the compiler finds every caller that did not.
- **The gallery stores REFUSE to construct without a vector index.** The
  provider is the sqlite-settings builtin — the same addon that serves
  `settingsStore` — so its absence is not a degraded mode, and a face gallery
  with no vector home is recognition that silently matches nobody.
- **`getByIds` still returns no vectors.** `fetchByIds` is a separate method,
  not a flag, because `getByIds`'s one caller depends on the promise it makes.
- The `embedding` columns stay DECLARED and `notNull`. They are drained, not
  dropped: unconverted rows still carry their array, and the column is the
  idempotence marker. Dropping them is a later, separate change.
- Cost: one `getByIds` read-back per cascade batch, and one `fetchByIds` per
  gallery load. Both are metadata-or-named-id reads on the same connection; the
  read they replace paged 10.8 KB rows.

## Enforcement

- `retention/__tests__/embedding-orphan-scan.spec.ts` — every protective class
  (live / grace / unresolvable / probe-failure / unverified delete), each with a
  fixture whose "kept" and "reclaimed" are different non-zero numbers.
- `store/__tests__/embedding-vector-migration.spec.ts` — the conversion is
  idempotent, pages past one page, and **does not drain the column when the
  index write did not land**.
- `store/__tests__/object-embedding-maintenance.spec.ts` — the cascade leg
  reports 0 when a delete throws AND when it returns without removing the rows.
- `pipeline/__tests__/delete-track-cascade.spec.ts` — `absentCascadeLegs` names
  the missing legs, and the empty answer is a different registry length.
- `packages/system/src/builtins/sqlite-storage/__tests__/vector-index-vec.spec.ts` — against the REAL
  sqlite-vec: `effectiveTopK` reports 4 096 for a request of 20 000, `scan`
  walks the whole table across pages, and `fetchByIds` returns the same bytes
  the upsert was given while `getByIds` still returns none.
- Nothing guards "no caller enumerates through `query`". Review only, and worth
  writing down: the shape is recognisable (a `topK` that is not a result count),
  and the cap docblock now names it.
