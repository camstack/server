---
id: D342
title: A backup run is queued, observable, cancellable — and cleans up on every exit
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/system/src/builtins/backup-orchestrator/**
  - packages/system/src/builtins/system-backup/**
  - packages/types/src/capabilities/backup.cap.ts
  - packages/addon-admin-ui/src/components/backup/BackupRunsPanel.tsx
---

## Context

On 2026-09-04 the operator triggered a backup and found the disk filling:
staging grew 5.1 GB → 18 GB in ~12 minutes at host load 62, because two
schedule ticks had started two archive builds CONCURRENTLY and (pre-D338
staging placement) each was archiving the other's growing tar.gz. There was
no way to stop them — `backup.cap.ts` had trigger / list / restore / delete
and NO cancel; the only lever was restarting the whole addon, which killed
the work with no cleanup. Nothing reported that two runs existed or how
large they had grown — the runaway was found with `du`. Staging also held
archives from 28 Jul, 8 Aug and 4 Sep: no path removed a staged archive
after failure or restart.

D338 fixed WHAT a backup archives and WHERE it stages, and added a
single-flight `buildLock` plus a boot sweep. The lock serialised builds but
was invisible (a waiting trigger looked hung), unjoinable and uncancellable.

## Decision

Backup execution goes through ONE global queue, concurrency 1 — never
per-destination. Every run walks the same `<nodeDataDir>` source tree and
stages on the same disk; the build is the expensive half, so a
per-destination lock would still permit the incident (two concurrent walks,
double staging peak). A trigger that arrives while a run is in flight is
enqueued — or JOINED onto an identical already-queued request (same
destinations/locations/label/retention, order-insensitive) — and
`backup.trigger`'s result says which happened (`runId`, `queued`, `joined`,
`cancelled`). The queue (`run-queue.ts`) is the single serialisation
authority for archive builds; the old `buildLock` is gone and no second
lock may be reintroduced around the executor.

Every run is observable WHILE it runs via `backup.listRuns`: state
(queued/running/succeeded/failed/cancelled), phase (building/uploading),
staged compressed bytes as the archive grows, uploaded bytes, and
per-destination outcome — plus a bounded finished history. `listRuns`
answers in EXECUTION order — the running run, then queued runs in the
exact order the pump will start them (each stamped `queuePosition`,
1 = next, read straight off the pending array), then finished
newest-first. The order and the positions are stamped by the
orchestrator, never re-derived from timestamps by a consumer: a
newest-first sort puts the run that starts NEXT at the BOTTOM, which is
backwards exactly when the queue matters.

`backup.cancel({ runId }) → { cancelled }` mirrors
`storage-migration.cancel` and actually stops the work, not just a row: a
queued run is removed before it ever starts; the running run's
`AbortSignal` aborts the tar via `stream.pipeline(..., { signal })` (the
build streams to the sink for exactly this reason — `tar.create({ file })`
cannot be aborted or byte-counted), aborts the in-flight chunked upload
server-side (partial discarded at the destination), and skips the remaining
destinations with a log line. Destinations that already completed keep
their archive and manifest entry — cancel never destroys landed work.

Cleanup is a first-class exit contract, not a `finally` habit: success,
failure and cancel all delete the staged archive (the build deletes its own
half-written file on abort; the run's `finally` covers the fan-out); addon
shutdown aborts every non-terminal run so its own cleanup fires; and the
one gap no in-process path can cover — the process dying mid-write — is
reclaimed by the existing D338 boot sweep, which removes everything in
`backup-staging` except a pending-restore's archive.

## Consequences

- `backup.trigger` now returns `{ runId, queued, joined, cancelled,
  entries }` instead of a bare entry array, and the cap gains `listRuns` +
  `cancel` — a framework change: `packages/types` + codegen + a published
  `@camstack/server` before any node sees it (D16).
- A cancelled run is an outcome, not an error: `BackupCancelledError` is
  how layers signal it, and a run that stops early with partial fan-out
  reports `cancelled`, never a clean success.
- Two distinct schedules due on overlapping ticks now run sequentially;
  peak staging disk is bounded to one archive by construction.
- Run history is in-memory and bounded (20): it does not survive a runner
  restart, by design — durable history is the per-location manifest.
- The Backups screen surfaces the runs (`BackupRunsPanel`): live staged
  bytes while building, a Cancel/Stop control whose confirm states exactly
  what survives, and outcomes reported honestly (a stopped run reads
  "Stopped", never success). Pending and empty are distinct states (D315).

## Enforcement

`packages/system/src/builtins/backup-orchestrator/__tests__/run-queue.spec.ts`
(single-concurrency, FIFO, join, cancel-queued, cancel-running,
cancelled-not-success, observability, bounded history, and the
execution-order + queuePosition contract — RED under a newest-first
sort) and
`packages/system/src/builtins/system-backup/__tests__/system-backup.service.spec.ts`
("createArchive cancellation + progress": mid-tar abort stops the stream
and deletes the partial; progress bytes end at the on-disk size). Both were
verified RED against the broken variants (concurrency guard removed;
pipeline signal ignored). The UI layer is pinned by
`packages/addon-admin-ui/src/components/backup/__tests__/BackupRunsPanel.spec.tsx`
(pending ≠ empty, live staged bytes, stopped ≠ succeeded, cancel wiring,
consequence text) — verified RED against pending-rendered-as-empty and
cancelled-rendered-as-succeeded.
