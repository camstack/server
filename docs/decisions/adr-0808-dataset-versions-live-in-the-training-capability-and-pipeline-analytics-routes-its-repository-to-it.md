---
id: D808
title: Dataset versions live in the training capability once it exists; pipeline-analytics still cuts them and MOVES its local rows there once
status: superseded
date: 2026-10-08
supersedes:
applies-to:
  # drift-ok: freeze/version stores removed; superseded by D824 (live TrainingCorpusSelection)
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-dataset-version-routing.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-dataset-version-store.ts
  - packages/addon-training/src/orchestrator/stores.ts
---

## Context

D796 kept dataset versions in pipeline-analytics behind
`RetrainDatasetVersionRepository` until a `training` capability could own
them, and expected that capability to "take over the five methods". When it
landed, moving the methods would have forked the Retrain page between two
caps and made a version's frames — which only pipeline-analytics can compute,
because it owns the corpus and the export plan — a cross-cap round trip. And
`training` is an optional package: without it, versions must still work.

Rejected:

- **Moving the five methods to `training`.** The Retrain page would need two
  code paths, and the cut (plan → frames → hash) would have to be exposed as
  a new pipeline-analytics primitive anyway.
- **Copying the local rows and leaving them in place.** A version deleted in
  training would come back on the next import.

## Decision

**pipeline-analytics keeps cutting versions and keeps its five methods; its
repository is routed: no `training` provider → the local store; a `training`
provider present → every read and write goes to `training`'s row methods,
after the local rows are MOVED (put, then removed — never left to be
re-imported). A presence read that fails changes nothing (D49); a move that
fails keeps the rows local and is retried on the next call.**

## Consequences

- The Retrain page and the export are unchanged; the Training page reads the
  same rows through `training.listDatasetVersions`.
- `training` exposes row-level methods (`put/get/list/findIdByName/remove
  DatasetVersion`); they are admin-only and exist for this route.
- Uninstalling addon-training strands its rows in `training:dataset-versions`;
  pipeline-analytics falls back to an empty local store. Recorded, not solved.

## Enforcement

`retrain-dataset-version-routing.spec.ts` (local while absent, move once,
failed presence keeps the last answer, failed move retried).
