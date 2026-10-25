---
id: D866
title: The whole-archive face rescore is a paced single-flight job, and an hourly job runs it only when a fingerprint changed
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/face-rescore-job.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-rescore-scheduler.ts
  - packages/types/src/pipeline/face-rescore-schedule.ts
---

## Context

`Face.suggestedIdentityId` / `suggestedMatchScore` are a photograph of the gallery
at detection time. `face.rescoreTrack` recomputes ONE face on demand, and the
viewer's "Recompute suggestions" button looped it over the few dozen rows on
screen. Every enrolment since then stayed invisible to the rest of the archive
(thousands of unassigned faces). The header of `face-rescore.ts` argued there
should be no background job; the argument was against re-scoring everything on
every assign, which is still right, but it left no answer for the archive.

## Decision

1. **One job, two doors.** `face.rescoreAll` (admin mutation) starts, and
   `face.rescoreStatus` (admin query) reads, a single-flight whole-archive
   rescore: a second start while one runs returns the running job. The hourly
   scheduler starts the SAME job. Progress and the final report are one shape:
   `{ jobId, state, scanned, total, changed, newlySuggested, raised, lowered,
   cleared, modelMismatch, noVector, batches, maxBatchStoreMs, durationMs,
   galleryFingerprint, fingerprint }`.
2. **No second scoring implementation.** Every face goes through
   `buildFaceRescoreReport` and `persistRescoreResult`; the bulk path only
   changes when the write lands (collected, one transaction per batch). Never an
   assignment; a `model-mismatch` face is never written and keeps whatever it had.
3. **A suggestion may be LOWERED or CLEARED.** The result is the truth for the
   current gallery: a face whose best match fell under the band, or whose person
   was removed, loses the suggestion. Keeping a stale "this is Anna" that no
   longer follows from anything is worse than showing nothing.
4. **Paced against `hub/sqlite-settings` (D447).** The pending ids are
   snapshotted once (indexed read), then paged BY ID, 200 per batch, never by
   offset against a table the recognizer is writing. Each batch is one narrow
   two-column `transact`, only for faces whose suggestion changed. The store time
   of every batch is measured; the job pauses 2x that (25 to 500 ms) before the
   next. One gallery and one identity-name map are read at the start.
5. **Change-gated cadence.** Setting `faceRescoreIntervalMinutes` on the
   orchestrator's global settings (default 60, 0 = off, 1 to 9 run as 10),
   re-read each tick, so no restart. The scheduler ticks every minute, runs when
   the interval elapsed since the previous check, and the first run is one
   interval after start. It runs the job only if the fingerprint differs from the
   one stored by the last completed run (manual runs included): sha256 of the
   cluster face model, every gallery sample (id, identity, model) and the
   unassigned-face marker (count + newest timestamp). Unchanged: one info line,
   "face rescore skipped, unchanged".

## Consequences

- Per-device matcher thresholds are NOT in the fingerprint (they resolve per
  device and the marker cannot tell which devices matter). Raising a threshold
  takes effect at the next gallery or face change, or on the manual button.
- A face assigned while a run is in flight is skipped at its batch read; one
  assigned between that read and the write may receive a suggestion on an
  assigned row, which every reader ignores.
- Faces without a vector are counted (`noVector`), never folded into "no match".
- The state row (`pipeline-analytics:face-rescore-state`) is one KV row; losing
  it costs one extra, idempotent run.

## Enforcement

`face-rescore-job.spec.ts` (accounting, batching, single-flight, model-mismatch),
`face-rescore-scheduler.spec.ts` (change gate, 0, boot, shared single-flight),
`face-rescore-marker-plan-over-real-sqlite.spec.ts` (the marker is a covering
index search), `face-rescore-settings.spec.ts` (key, default, bounds).
