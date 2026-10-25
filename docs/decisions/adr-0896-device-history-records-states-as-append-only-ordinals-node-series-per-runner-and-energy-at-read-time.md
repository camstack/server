---
id: D896
title: device-history records a state as an append-only ordinal, a node's load per runner, and energy at read time
status: accepted
date: 2026-10-21
applies-to:
  - packages/system/src/builtins/device-history/store/series-registry.ts
  - packages/system/src/builtins/device-history/query/history-query.ts
  - packages/system/src/builtins/device-history/query/point-shape.ts
  - packages/system/src/builtins/native-metrics/node-metrics-history-recorder.ts
  - packages/system/src/builtins/storage-orchestrator/location-history-recorder.ts
---

## Context

device-history (D850) knew three kinds: gauge, counter, boolean. Lock, alarm
panel, appliance program and dishwasher states had `history: 'none'` because
text has no number, so "how long was the lock jammed this week" had no answer.
The node series were scoped one per PROCESS ID: a pid changes on every runner
restart, the hub held ~11.8k node series (most one restart long), and no chart
could follow a runner across a respawn. The 5-minute tier was kept 14 days,
shorter than the month an operator compares against. A power meter's `kwhTotal`
was stored but nothing turned it, or a bare `watts`, into energy per hour.

Two smaller faults surfaced on the way. `query` with `resolution: 'auto'` read
raw first for a series fed by closed buckets, which has no raw rows: the empty
read "fit" and the chart was empty. The node reads named their subject `nodeId`,
which is the cap ROUTING key, so `queryNode({ nodeId: 'agent-a' })` was
sent to that agent and failed "device-history not available on node".

## Decision

- **`enum` is a fourth kind.** A state is stored as the ORDINAL of its value in
  the metric's value list, change-only with no floor. The list is
  APPEND-ONLY and persisted with the metric (`enum_values`): codegen projects a
  `z.enum` field's values into the catalog, a boot merges them into the stored
  list by appending what is missing, so reordering a `z.enum` never changes what
  a stored ordinal means. A `z.string` field (enum-sensor, whose option set is
  per device) LEARNS its values, bounded (`MAX_ENUM_VALUES`, refused and counted
  `enum-overflow` beyond it); a learned value is stored before the first point
  that names its ordinal. Rollups keep the milliseconds spent in each state
  (`state_ms`), the gap before a bucket credited to the state held into it;
  a query names them (`state`, `states`) and answers `mean` / `twMean` as null.
  Producers cannot declare an enum: its value list is the cap field's.
- **Node series are scoped per runner.** The scope is the load fold's own
  function key — the runner's addon id, `__root__`, `__unattributed__` — so the
  cold tier folds like the hot ring and a runner keeps one series for life. Node
  totals (CPU %, memory %, CPU and GPU temperature, GPU %) and per-location
  storage occupancy (volume used %, free bytes, bytes CamStack holds) are
  recorded too, each from the authority that already serves it, and a reading
  that was not taken is no point (D393). The PID-scoped keys are no longer
  written; their rows age out (no migration).
- **Retention of the 5-minute tier is 30 days** (raw 7, 1h 365, 1d forever).
- **Energy is computed at read time** under one derived key,
  `derived:energy.kwh`: the device's `kwhTotal` meter when it has one (growth
  per bucket, a drop counted as a reset from zero), else the time-weighted
  integral of its `watts` (`tw_sum`, already in every rollup). Every counter
  point also carries its `delta`.
- **Node reads take `forNodeId`**, never a top-level `nodeId`; `queryMany`
  batches up to 24 reads over one window (admin-only: nested subjects are
  invisible to the device scope gate).

## Consequences

- An ordinal is meaningless without its metric row: the value list must never be
  rewritten in place, only appended. A future "rename a state" is a new value.
- A learned enum shares ONE dictionary per key across every device of that cap,
  hence the bound; a free-text field that slips in fills it and is then refused
  out loud rather than growing every row.
- Energy has no row of its own: a chart of it costs one rollup read of its
  source, and history recorded before the key existed is covered. A stored
  energy series was rejected because it would be a second copy of the meter
  that can disagree with it, and would start empty.
- A query caller that sent `nodeId` to `listNodeSeries` / `queryNode` must send
  `forNodeId`. The cap change needs `@camstack/system` and `@camstack/server`
  force-published.
- The metrics table was being written under an engine-minted random key (the
  key is the PRIMARY KEY and the store did not pass it as `id`), so every boot
  added a row per metric that no lookup could reach and a learned enum list
  would not have survived a restart. The key is now passed; unreachable rows are
  deleted at load.

## Enforcement

- `scripts/check-cap-history-declared.ts`: an `enum` field is a `z.enum` or
  `z.string`, takes no unit or deadband, never a hand-written `values`, and a
  `skipWhenSet` names a field.
- Specs: `enum-capture.spec.ts` (ordinals, time in state, append-only merge,
  learned values across a restart, overflow, derived energy),
  `node-routing.spec.ts` (no device-history method declares a top-level `nodeId`),
  `history-query.spec.ts` (auto over a bucket series), `history-ddl.spec.ts`
  (the new columns arrive in place, rows survive),
  `node-metrics-history-recorder.spec.ts` (per-runner scope across a respawn).
