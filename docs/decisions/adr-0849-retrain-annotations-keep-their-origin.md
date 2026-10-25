---
id: D849
title: Retrain annotations keep their origin — a saved box remembers the proposal it started from, a deletion is a durable fact, and a save is atomic and revisioned
status: accepted
date: 2026-10-14
supersedes:
applies-to:
  - packages/types/src/retrain-review.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/types/src/capabilities/settings-store.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/**
  - packages/addon-training/src/page/frames/**
  - packages/mcp-develop/src/track-review/**
  - packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts
---

## Context

An annotation row kept only the FINAL rectangle plus `source` / `assistModelId` /
`assistScore`. Whether the operator accepted a pipeline box as drawn, nudged it,
relabelled it, deleted it or drew a new one was lost when Save was pressed — and
that difference is the signal that says where the detector is wrong. Proposals
were never stored at all: `pipelineBoxes` are re-derived from the track store on
every listing, so they disappear when the track is evicted, and a detector or
vision-LLM proposal existed only in the browser.

Four defects followed from the same missing memory:

- A pipeline box the operator DELETED re-appeared as a draft every time the frame
  was reopened. `seedEditor` de-duplicated pipeline boxes only against SAVED rows,
  and a deleted box is, by definition, not saved.
- `saveRetrainAnnotations` replaced the whole frame as N inserts then M deletes,
  not atomically, with no revision: the admin page and an MCP agent were
  last-write-wins, and a crash between the two phases left a frame over-annotated.
- The frame image travelled as base64 inside a tRPC answer, once per grid tile
  (D613).
- `track_review_apply` copied pipeline boxes as `source: 'operator'`, dropping the
  model and score — provenance mislabelled by the one tool that exists to curate
  at scale.

Tried first and rejected: storing "the operator's edits" as a diff. A diff needs
the base, and the base (the re-derived pipeline box) is exactly what is not
stable.

## Decision

A retrain annotation carries the proposal it started from, and the frame carries
the proposals the operator turned down.

- `origin` (nullable) on every annotation: `{ source, ref, bbox, macroClass,
  label?, score?, modelId? }`, snapshotted when the box was offered. `ref` names
  the proposal in its frame — `pipeline:<trackId>`, `assist:<n>`, `llm:<n>`,
  `operator:<n>` — and is stable across re-derivation. A legacy row has `null`.
- `dismissed[]` on the frame: `{ ref, snapshot }` of every proposal deleted. The
  editor never re-seeds a dismissed ref, and keeping a proposal again removes it
  from the set. A deletion is a recorded fact, not an absence.
- `revision` on the frame, bumped by every annotation save. `saveRetrainAnnotations`
  takes an optional `expectedRevision`; a different current revision writes
  nothing and throws `retrain-revision-conflict` (`parseRetrainRevisionConflict`).
  Absent, the save is last-write-wins and retries its own lost races.
- The save is ONE transaction — old rows out, new rows in, `dismissed` and
  `revision` — through a new `settings-store.transact` (an optional guard read
  inside the transaction, then deleteWhere / insertMany / update ops). No cap
  method gets a bespoke engine path.
- What the operator did is computed by ONE pure function, `classifyRetrainReview`
  (`@camstack/types/client`): `added | removed | reclassified | adjusted |
  unchanged | model-error`, with `model-error` never folded into `removed` (a
  removed proposal teaches nothing; a model error teaches a specific false
  positive). List answers carry the server-computed `review`. A legacy frame is
  judged lazily against the pipeline boxes re-derived now — exact rectangle first,
  then best overlap — and every verdict reached that way is flagged
  `approximate`. There is no backfill migration on boot.
- `backfillRetrainOrigins` sets `origin` on rows that have none and touches
  nothing else (ids, creation time and the export stamp survive; a re-save would
  reset all three); it never overwrites an existing origin. The MCP tool
  `track_review_backfill_origin` drives it, dry-run unless `confirm: true`.
- Frame bytes leave through the admin data plane `retrain-frame`
  (`?size=thumb|full`), not the cap. `getRetrainFrameImage` stays one release,
  deprecated.
- `track_review_apply` saves a pipeline-derived box as `source: 'pipeline'` with
  its model, score and origin, and names the frame revision it read.

## Consequences

- A new nullable JSON column on annotations (`origin`) and two on frames
  (`revision` INTEGER NOT NULL DEFAULT 0, `dismissed` JSON). Added in place by the
  additive path of `declareCollection`; no row is rewritten.
- A cap and types change: `@camstack/types`, `@camstack/system` and
  `@camstack/server` must be published and applied (a hub on the old closure
  has no `transact`, so a new post-analysis addon refuses to save there).
  `addon-post-analysis`, `addon-training` and `mcp-develop` ship separately.
- Specs that fake the settings store need `transact`.
- A legacy frame's review is a best effort. The approximate flag is the contract:
  a consumer that aggregates reviews must not count an approximate verdict as
  evidence about the model.
- Assist and LLM proposals are snapshotted only when the operator KEEPS or
  DELETES them. A proposal never touched is not stored; a refused or ignored
  proposal run leaves no record.

## Enforcement

`retrain-review.spec.ts` (the classification), `transact-over-real-sqlite.spec.ts`
(atomicity and the guard against a real SQLite file), `retrain-review-save.spec.ts`
(origin round trip, dismissed persistence, stale-revision refusal, backfill),
`retrain-dismissed.spec.ts` (a deleted box is not re-seeded) and the track-review
specs for apply provenance and the backfill confirm gate. Each was proven RED by
removing the thing it guards.
