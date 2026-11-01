---
id: D992
title: A device run is recorded by device-history, not by pipeline-analytics
status: accepted
date: 2026-11-01
supersedes:
applies-to:
  - packages/system/src/builtins/device-history/runs/**
  - packages/types/src/capabilities/device-runs.cap.ts
  - packages/addon-post-analysis/src/notification-center/appliance-cycle-runs.ts
---

## Context

The appliance finish notification knew a cycle's start only from an in-memory
map fed by the sensor stream (`ApplianceCycleStarts`): a restart of the runner
forgot every cycle in flight, and energy was always unknown. A durable run
record was wanted, generic enough to later carry a mower or a vacuum run.

The first placement was pipeline-analytics, next to the notification code that
reads it. That addon is a forked, restartable process with no ledger of its own
and no history of the meter, and the energy of a run is a question about the
device's stored history (the counter fallback).

## Decision

The `device-runs` capability (wrapper, `defaultActive`, Washer/Dryer/Dishwasher)
is provided by the device-history builtin. It owns the `device-runs` record kind
(events DB, ledger, `maxRowsPerDevice` 500, `deviceRemoval: 'delete'`), opens and
closes a run from the `running` flips of `running-state`, and reconciles open
rows against the snapshots at boot. Consumers read it through `ctx.api` only; the
notification centre reads the newest run behind its existing port.

## Consequences

The recorder shares the device-history runner and its closure shipping channel
(a framework and cap change: publish the closure, `applyServerUpdate`). A run
closes a moment after the flip, so the notification waits a bounded 3 s for it
and falls back to the open run's start (energy unknown). Energy is the meter
counter at the end minus at the start, else the 5-minute history buckets
(precision is the bucket); a failed measurement is `null`, never 0.

## Enforcement

`run-recorder.spec.ts` (restart survival with a marked fixture field, counter
delta, reconcile never duplicates) and `appliance-cycle-runs.spec.ts`; the cap
vocabulary, method-tier and export-coverage guards.
