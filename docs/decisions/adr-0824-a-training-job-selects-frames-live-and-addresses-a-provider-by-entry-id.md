---
id: D824
title: A training job selects frames live and addresses a provider by entry id
status: accepted
date: 2026-10-10
supersedes: D808; D796 (frozen dataset versions); D805 (only "owns dataset versions" and "routed by addonId")
applies-to:
  - packages/types/src/capabilities/training.cap.ts
  - packages/types/src/capabilities/training-provider.cap.ts
  - packages/addon-training/src/orchestrator/plan-job.ts
  - packages/addon-training/src/orchestrator/job-engine.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-training-corpus.ts
---

## Context

The Training admin redesign (operator 2026-10-10) removed dataset freeze /
versioning end to end. Frozen versions had been the plan/start authority
(D796 → D808): the operator cut a version, then a job named its id. That
forced a Collections/Datasets UI nobody wanted, duplicated the export plan,
and left jobs pointing at frame sets that could no longer be re-derived from
live filters. Separately, D805 routed cloud work by bare `addonId`, so one
provider type could not hold two credentialed accounts.

Rejected:

- **Keep freeze as the job authority.** The Frames corpus already has
  collections and work states; a second frozen list was a parallel truth that
  drifted from the grid the operator curated.
- **Route jobs by addon id alone.** A second Modal workspace (or a staging
  entry) would need a second addon install; the broker already shows the
  multi-entry pattern Training needed.
- **Parallel multi-GPU for N base models.** The provider contract stays one
  cloud job → one model; the orchestrator enqueues a sequential batch instead.

## Decision

**`planJob` / `startJob` / `startJobBatch` take a live
`TrainingCorpusSelection` (collection ids + work-state rule; default
complete-only). pipeline-analytics resolves frame ids at that moment via the
same keep rule the annotated archive uses; the job persists the selection
criteria and a count snapshot for audit — never a `datasetVersionId`. Cloud
work is addressed by `entryId` (a named entry under a `training-provider`
type/addon); types come from the capability collection, entries from
`createEntry` / `listEntries`, and a migrate of a legacy single-account
config becomes one entry named "Default". One GPU job at a time still holds;
`startJobBatch` enqueues N jobs with the same selection and entry, one
`baseModelId` each, run sequentially.**

D805 still owns the orchestrator shape (reconcile, cost guard, retention,
never auto-register). Only its "owns dataset versions" and "routed by
`addonId`" clauses are struck by this record.

## Consequences

- Freeze/version UI, stores and cap methods are gone; callers that still ask
  for a version id must be migrated or refused by name.
- The Training Providers tab is an entry hub (pills = entries, Add = create
  entry from a type), not a one-row-per-addon list.
- Uninstalling a provider type drops its entries; jobs that named those
  entry ids fail as `unknown-provider` / `provider-not-configured` on
  reconcile.

## Enforcement

`addon-training/src/__tests__/freeze-removed.spec.ts` (no freeze methods;
request carries `selection` not `datasetVersionId`),
`job-engine.spec.ts` (batch sequential; entry routing),
`retrain-training-corpus` keep-rule agreement with export, and the
training / training-provider router specs (admin gates, entry CRUD).
