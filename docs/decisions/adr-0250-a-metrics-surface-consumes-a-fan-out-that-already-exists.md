---
id: D250
title: A metrics surface consumes a fan-out that already exists; retaining a series is a separate, declared decision
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-admin-ui/src/components/cluster/load/load-series.ts
  - packages/addon-admin-ui/src/components/cluster/load/use-node-load-series.ts
  - packages/system/src/builtins/native-metrics/thread-cpu-sampler.ts
---

## Context

The per-node load charts need a time series of CPU and memory per addon. There
is none. The search was exhaustive and the answer is uniform:

- `packages/system/src/kernel/heap-watch.ts` formats a line and forgets it —
  the only state kept between ticks is four scalars.
- `NativeMetricsProvider` holds exactly one `cachedSnapshot`, overwritten every
  sample (`packages/system/src/builtins/native-metrics/native-metrics-provider.ts:44`).
- Both snapshot topics are on the event ring's deny-list
  (`packages/system/src/kernel/moleculer/event-bus-core.ts:248`), so not even
  the last 1000 events retain them.
- No SQLite collection holds sampled CPU or memory. The `LtsAggregator`
  machinery exists and is production-proven, but its two tables carry pipeline
  scores and analytics baselines, not resources
  (`packages/addon-pipeline-orchestrator/src/durable/lts-aggregator.ts:57`). <!-- drift-ok: deleted when device-history replaced the LTS tier (D850) -->

So a chart needs someone to keep the series, and the obvious answers are both
wrong. Adding a per-node sampler at chart resolution is precisely the defect
`docs/architecture/load-ledger.md` was written about — four of its eight
entries are a reader that made the thing it measured worse, and the mirror
that "had a guard limiting CONCURRENCY, not FREQUENCY" read 4,987,368 rows in
120 s. Adding a durable `metrics-5m` table is a storage commitment — a
retention, a resolution, a row cap, an owner — that nobody asked for and that
would be taken silently in the middle of a UI change.

There is also a subtler trap in the data that already exists: every CPU number
in this app comes from `ps pcpu`, which is a **lifetime average**
(`packages/system/src/builtins/native-metrics/native-metrics.addon.ts`, `runPs`).
Charted as a series it is a flat line that cannot show a spike, and a merged
total hides the finding that rewrote the 2026-08-27 diagnosis: ~2 cores of the
container were collecting garbage, not computing.

## Decision

**A metrics surface reads a fan-out the cluster already produces and keeps its
own bounded buffer for as long as it is open. It never installs a sampler on a
node, and it never quietly creates durable retention — a stored series is its
own decision, with its resolution, retention and owner stated.**

The Load tab therefore subscribes to `metrics.node-processes-snapshot`, which
`native-metrics` emits every 20 s per node whether or not anyone is watching,
and buffers 180 points ≈ one hour in the browser. Nothing is persisted. The UI
states this on the page: the window is how long the page has been open.

The one new READ this work does add is bounded by the same rule: the
thread-CPU split rides the existing 20 s process tick, scans
`/proc/<pid>/task/*/stat` for the camstack-shaped pids only, and adds no timer.
It is strictly cheaper than the whole-process-table `ps -eo` that tick already
runs, and it earns its place by fixing both defects above at once — it yields
an instantaneous rate AND the GC share.

## Consequences

- The charts start empty and cannot answer "what happened overnight". That is
  stated on the surface rather than hidden behind an interpolated line.
- A durable series remains available as a follow-up with a shape already
  decided by precedent: `LtsAggregator`, 5-minute buckets, `samples/sum/min/max`
  per `(subject, series, bucket)`, a 105,120-row cap ≈ one year, declared in
  `docs/reference/storage.md` and read through a cap method. Choosing it is a
  separate record; this one only forbids doing it by accident.
- `cpuMainPercent` / `cpuGcPercent` are nullable on the wire, and `null` means
  UNKNOWN — a non-Linux node, a recycled pid, or the first tick after a
  restart. Any consumer that renders `null` as `0` reintroduces exactly the
  plausible-wrong-number failure.
- The process-snapshot dedup now buckets the split, so a runner whose GC share
  doubles emits even though its lifetime average did not move.

## Enforcement

`packages/system/src/builtins/native-metrics/__tests__/thread-cpu-sampler.test.ts`
asserts that an unreadable `/proc` yields `null` rather than a zeroed sample,
that a backwards tick count (a recycled pid) yields `null` rather than a
plausible small number, and that the tracker forgets a pid that stops
appearing. `packages/addon-admin-ui/src/components/cluster/__tests__/load-series.test.ts`
asserts the 180-point cap drops the OLDEST point. All were verified by
disarming the guard and confirming the red.

Nothing mechanically prevents a future surface from adding a sampler. That is
review only — and the load ledger is the record a reviewer should point at.
