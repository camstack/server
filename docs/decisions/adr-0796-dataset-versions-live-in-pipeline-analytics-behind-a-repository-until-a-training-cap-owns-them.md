---
id: D796
title: A dataset version is immutable and cut from the export plan, and pipeline-analytics holds it behind a repository until a training capability owns it
status: superseded
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-dataset.ts
  # drift-ok: version service/store and RetrainDatasetsPanel removed; superseded by D824
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-dataset-service.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-dataset-version-store.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-admin-ui/src/components/retrain/RetrainDatasetsPanel.tsx
---

## Context

The cloud training plan (§5.2) has the training orchestrator own dataset
versions: a frozen frame list, the annotation hashes and the export
parameters, stored with the weights and metrics a run produced. The
`training` capability does not exist yet, and the operator needs versions now:
to see what a selection holds (class × camera × day/night, completeness)
before training, and to name exactly what a run learned from.

Two easy shapes were wrong. Computing a version's frames with a second query
next to the export's would let the version and the archive disagree about
"the frames of this selection". Putting the store wherever was convenient in
pipeline-analytics would make the later move a rewrite of every caller.

## Decision

**A dataset version is cut from the annotated export's own plan
(`buildRetrainExportPlan`): its frames are exactly what an export of the
selection carries, its counts and its `annotationHash` are computed from that
manifest, and it is never updated — a different selection is a new version.
Until a `training` capability exists, pipeline-analytics stores versions
(`pipeline-analytics:retrain-dataset-versions`) behind
`RetrainDatasetVersionRepository` (insert, get, list, findIdByName, remove),
and nothing outside `retrain-dataset-service.ts` touches the store.**

- The hash covers what the frames teach: per frame its completeness and per
  box the class tiers, kind and box (rounded to 1e-4). Row ids, timestamps,
  provenance and export stamps are excluded. Order-independent.
- The export takes a version as a filter (`datasetVersionId`): exactly its
  frames and its `completeOnly`; an unknown id selects nothing. The manifest
  records the version, the frozen hash, the hash now, and missing frames.
- Deleting a version deletes no frame; deleting a frame does not edit a
  version (`verifyRetrainDatasetVersion` reports it).

## Consequences

- When the `training` capability lands, it implements the repository (or
  imports these rows) and takes over the five methods; the Retrain page and
  the export do not change.
- A version records its selection and parameters, not split assignments
  (train / holdout); the training orchestrator adds those.
- `frameIds` sits in the row as JSON (≤ 20 000 ids, the export's own bound).

## Enforcement

`retrain-dataset.spec.ts` (counts, hash stability and sensitivity, the
manifest's version block), `retrain-dataset-service.spec.ts` (preview writes
nothing, immutable create, refusals, verify after the corpus moved, an unknown
version exports nothing, delete keeps frames) and
`retrain-datasets-panel.spec.tsx`. Review only for "nothing else touches the
store".
