---
id: D1105
title: A long-running operation is a job in one per-user ledger, owned by whoever started it
status: accepted
date: 2026-11-26
supersedes:
applies-to:
  - packages/types/src/capabilities/jobs.cap.ts
  - packages/types/src/capabilities/job-source.cap.ts
  - packages/system/src/builtins/alerts/jobs/**
  - packages/system/src/builtins/device-manager/adoption-job-engine.ts
---

## Context

Adoption, imports, scans and similar work take minutes. Each kept its own
in-memory job (the adoption engine's `AdoptionJob`), visible only on the page that
started it and lost on a restart. Two shapes were considered first: stretching
`alerts` with an `Alert.progress` (an alert is a notice about the system for
admins, not a record of what one person started, and its rows carry severity,
episode and notification semantics a job must not inherit), and a per-app
activity list (each app would re-implement ownership, retention and reconcile).

## Decision

A `jobs` capability, hosted inside the alert-center builtin with its own record
kinds (`jobs`, `job-dismissals`; no shared rows with `alerts`), is the one ledger
of long-running work. A producer addon declares `job-source`, registers a job
(`jobs.register`, idempotent on its `idempotencyKey`) and reports `jobs.update`
(a state change is written at once, progress at most every 5 s). A state is
`queued | running | done | failed | cancelled`; a terminal state never walks back.

- **Visibility is owner-only.** A caller sees their own jobs; an admin also sees
  jobs registered with `audience: 'admins'` (work nobody started: automatic
  adoption, owned by `system`). Enforced in one place, `job-policy.ts`.
- **Cancel goes to the producer.** The ledger never changes a job's state on a
  cancel; the producer's next update does. A job that cannot stop cooperatively
  registers `cancellable: false`.
- **`JobChanged` (`jobs.changed`) is a hint only.** It carries `{ jobId, state }`;
  a consumer re-reads `list` / `get`. Loss of the event changes nothing.
- **Reconcile follows D49 and D3.** On the `job-source` ready-state and when a
  read meets a job not confirmed for 60 s, the ledger asks the producer
  (`getJobs`). A failed read changes nothing; a job is marked
  `failed / interrupted` only after a second read confirmed the producer no
  longer knows it, past a 10 s grace.
- **A job may name an entity.** `subject.entity = { kind, id }` (beside
  `deviceId` / `nodeId`) and `list({ entity })` filter to the jobs of one
  integration, camera or any other object a page shows.
- **Retention is configurable**, through `retention-source` knobs on cap `jobs`:
  `jobsRetentionDays` (default 30) and `jobsMaxPerOwner` (default 200). Only a
  terminal job is pruned; a queued or running one never is.

## Consequences

An app shows a user's activity with one query instead of owning a job store.
Every producer implements `job-source` so a restart cannot leave a job `running`
forever. The adoption engine is the first producer; its in-memory job stays the
engine's own state and the ledger copy is best effort (a ledger failure is logged
and never fails the work).

## Enforcement

`jobs-provider.spec.ts` (audience, idempotent register, terminal no-walk-back,
retention, reconcile second read, entity filter, progress throttle) and
`adoption-job-ledger.spec.ts`; each gate was removed once to see its spec fail.
