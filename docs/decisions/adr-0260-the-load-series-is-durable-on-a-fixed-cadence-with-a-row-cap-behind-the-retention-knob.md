---
id: D260
title: The load series is durable, emitted on a fixed cadence, and bounded by a row cap the retention knob cannot raise
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/system/src/builtins/native-metrics/load-series-config.ts
  - packages/system/src/builtins/native-metrics/load-series-reader.ts
  - packages/types/src/metrics/load-series-fold.ts
---

## Context

D251 kept the last 180 process snapshots per node in RAM and said, explicitly,
that a durable series remained a separate decision with its own resolution,
retention and owner. This is that decision.

Three things forced the shape it took.

**The emission was conditional, and that made a hole ambiguous.** The process
snapshot fired only when a coarsened payload had changed, with a 60 s fallback
heartbeat. A gap in the chart could therefore mean "nothing changed" or "nobody
reported", and telling those apart is the entire reason an operator opens this
chart after a spike. Fixed cadence removes the ambiguity and removes the
discount: the row count stops depending on how quiet the fleet is.

**The naive row cost too much.** One row per process per sample, with a `TEXT`
composite key, two indexes and every `NodeProcess` field, measures at **196.1
bytes per row** through the real engine. At the originally requested three days
at 10 s that is ~2 M rows and ~370 MiB added to a `camstack.db` already at 858
MB. The first response was to change the SHAPE — a dimension table, or a
per-addon pre-aggregate, or an `LtsAggregator`-style bucket tier. The operator
rejected all three: one table, the standard shape the repo uses everywhere.
So the saving had to come from inside one table, and the retention default had
to come down. Both happened.

**A stored series is worth nothing if the read hides what you stored it for.**
Six hours at 10 s is 2 160 points per series and a chart a few hundred pixels
wide must reduce them. A mean per bucket smears a spike away; every-Nth skips
it. Either would produce a tool built to find peaks that does not show peaks.

## Decision

The load series is retained in **one table**, `metrics:node-load-samples`, one
row per process per sample, appended by the HUB in **one transaction per
sample** and never one per row. Emission is **fixed-cadence** — the operator's
`loadSeriesCadenceSec`, 10 s by default and REFUSED outside 5-60 — so a missing
interval means one thing only: nobody reported. Retention in hours is the
INTENTION; **`DEFAULT_MAX_ROWS` is the guarantee**, it bites regardless of the
knob, it evicts the oldest and it logs when it does. `getLoadSeries` is the ONE
reader over the in-memory ring and the table, deduping on `atMs`, folding per
function and reducing server-side by **preserving min and max per bucket** —
never a mean, never every Nth sample. An empty bucket is ABSENT: never zero,
never interpolated, never carried forward.

## Consequences

**The measured cost, on the shipped shape** — real engine, real
`declareCollection` DDL, `page_count x page_size` after a truncating checkpoint,
table plus index. `npx tsx scripts/measure-load-series-cost.mts`:

| cadence | retention | rows | on disk | B/row |
| --- | --- | --- | --- | --- |
| 60 s | 6 h | 27 360 | **2.3 MiB** | 87.4 |
| **10 s (default)** | **6 h** | **164 160** | **13.6 MiB** | **87.0** |
| 5 s | 6 h | 328 320 | **27.3 MiB** | 87.1 |
| 5 s | 72 h (knob ceiling) | 3 939 840 | 328.8 MiB | 87.5 — **capped at 500 k rows ≈ 41.5 MiB** |

**Where the 196.1 → 87.0 came from**, all inside one table:

| shape | B/row |
| --- | --- |
| naive: `TEXT` key, 2 indexes, every field | 196.1 |
| drop `command`/`threadCount`/`uptimeSec`, one index, CPU as integer tenths, RSS as integer MiB | 140.3 |
| + `INTEGER` rowid-alias key | **87.0** |

- `command` is not stored. It is the fattest field in a snapshot and the
  identical ~100-character string on every runner — the runner id travels in
  the environment, not in argv — while `addonId` already names the process.
- CPU is integer tenths, LOSSLESSLY: `runPs` and `ThreadCpuTracker` both
  already round to one decimal. RSS is whole MiB.
- The key is an `INTEGER` rowid alias. A composite `TEXT` key cost ~53 B/row
  (the string plus its own B-tree) to buy an idempotence the series gets for
  free elsewhere: `NodeLoadRing.record` now returns whether the sample was
  ACCEPTED, and only an accepted sample is appended.

**It lands on the NVMe cache, verified.** The table is a `declareCollection`
collection in `camstack.db`, whose path is `<ctx.dataDir>/camstack.db` =
`/data/addons-data/sqlite-settings/camstack.db`; `/data` is bound directly to
`/mnt/cache/appdata/camstack` on `/dev/nvme1n1p1` (btrfs RAID1, D147 —
container never touches shfs). The mechanical recordings disk is a separate
`filesystem-storage` location and the settings-store never writes to it. At the
10 s default the sustained write is **7.6 rows/s in 0.3 transactions/s**.

**What this forbids.** A second reader over either tier. A prune that scans the
whole table — both bounds go through a bounded page, oldest-first, on the one
`(nodeId, atMs)` index. A write per row: `settings-store.insertMany` was added
for this and is the only sanctioned batch path. And a reduction that reports a
central tendency where the surface promises a peak.

**What now has to be true elsewhere.** The cadence is cluster-wide, so a node
that emits at a different one produces a series that cannot be laid over the
others. The knobs live in `native-metrics`'s own global settings document —
fields, never a method per knob — and NOT in `system.setLoggingSettings`, which
is about levels and diagnostic windows. The settings form computes what a
configuration costs from OBSERVED node and process counts, so raising the
retention shows the number before it is applied.

## Enforcement

- `packages/types/src/__tests__/load-series-fold.spec.ts` — the peak survives a
  reduction to five buckets, an empty bucket stays absent, `null` propagates.
  It lives in `packages/types` deliberately: `packages/system` consumes the
  fold through the built dist, so a spec there would exercise the last build
  and stay green while the source was disarmed.
- `packages/system/src/builtins/native-metrics/__tests__/load-series-store.test.ts` <!-- drift-ok: deleted when device-history replaced the LTS tier (D850) -->
  — one `insertMany` and zero `insert` per sample; the prune probe carries a
  `LIMIT` and reads only `atMs`; the row cap bites, evicts oldest and logs; the
  cadence is refused outside 5-60.
- `.../load-series-reader.test.ts` — hot and cold merge without doubling a
  point.
- `packages/system/src/builtins/sqlite-storage/__tests__/insert-many-over-real-sqlite.spec.ts`
  — the batch is all-or-nothing and the `INTEGER` key stays a real rowid, over
  a real file.
- Every one of the above was DISARMED and confirmed RED before being kept.
- `scripts/measure-load-series-cost.mts` re-derives the ledger's number from
  the shipped column list, which it imports rather than restates.
