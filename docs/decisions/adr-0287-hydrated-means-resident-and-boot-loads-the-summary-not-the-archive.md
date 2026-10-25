---
id: D287
title: "`hydrated` means the rows are RESIDENT — boot loads the hour summary, never the archive"
status: accepted
date: 2026-08-29
supersedes:
covers:
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
---

> **Superseded in part by
> [D523](adr-0523-the-directory-says-which-segments-exist-and-the-table-says-how-much.md).**
> The PRINCIPLE below stands and is stronger than ever: nothing at boot may be
> proportional to the segment count, and `hydrated` still means the rows are
> RESIDENT. The MECHANISM is gone. The two-tier mirror, `pathsResident`, the
> `columns` projection, the point-read materialise and the live-tail warm all
> existed to keep ONE column — `paths` — out of the boot load, and that column
> was removed. A row is ten scalars now, boot issues one query with no
> projection, and nothing is deferred because nothing is fat. The half of this
> record that described "a ledger-known hour is hydratable from T3" is no longer
> true at all: a row says how MUCH an hour holds and never which files, so only
> a directory listing can seed the index. Vouching moved to `covers:` for that
> reason — read this for the argument, not for the code.

## Context

A 30 TB array is being attached. Two things in the recorder's boot were
proportional to the whole archive, and both were measured rather than feared:

- `DurableLedger.load` fetched the entire `recorder:segment-hours` collection in
  one query — every hour row including its `paths` blob. **17.7 MB of JSON at
  today's 1 507 hour rows / 295 k segments; 479 MB at the 28 TB projection**
  (47 k hour rows, ~8 M segments), parsed on the main thread before the index
  exists. At a low-bitrate mix the same arithmetic gives ~5.9 GB, which is an
  OOM against the runner's 3 264 MB heap limit, not a stall.
- `SegmentHourLedger.hydrateIndex` then replayed every hour into
  `RecordingIndex` with **no yield anywhere in the loop**. Measured on a
  synthetic ledger: **256–305 ms of blocked loop today, 12.1–12.5 s at 28 TB**,
  as one uninterruptible block.

An addon deploy restarts this runner — seven boots in under two hours on
2026-08-29 — so this was a recurring tax, not a one-off.

**What was tried first and was not enough.** Stage 1 removed the CPU churn
(incremental hour aggregate, binary-search reads, slice-not-copy): every
micro-benchmark improved by two to four orders of magnitude and the process
did not move — the `heapUsed` floor went *up*, from 1 384 MB to 1 844 MB. Churn
was not the retained set. That result is what made the residency question
unavoidable rather than optional.

**The dependency that made this more than a boot-time fix.** `hydrateIndex`
marked **every** ledger hour `hydrated`, and `hydrateWindowFromStorage` returns
early on a hydrated hour. So a segment finalized after the last hour-row
persist and before a crash — on the array, absent from the durable row — was
not "under-reported". It was invisible to playback and the timeline for as long
as the footage lived, and nothing could ever correct it: the disk was never
consulted for that hour again.

## Decision

**Boot loads T1 and only T1.** One query with a `columns` projection over
`[deviceId, profile, locationId, hourStartMs, bytes, segments, minStartMs,
maxStartMs]` — **never `paths`** — folded into the mirror in bounded chunks with
a yield between them. The archive replay is deleted.

**`hydrated` now means "the rows are resident".** A ledger-known hour is
*hydratable from T3*, not hydrated. A row loaded by the projection carries
`pathsResident: false`: its aggregates are the database's own, and its empty
`paths` mean **"not loaded"**, never "this hour is empty". Every path consumer
materialises first — one bounded point read by primary key — and **a
materialise that fails changes nothing**: the reader falls back to the disk
walk, the writer declines the append, eviction declines the drop, the reconcile
neither prunes nor unions. Nothing is ever persisted from a row whose paths are
not resident.

**The reader asks the ledger before it asks the array, for CLOSED hours only.**
The live hour is never served from the ledger — it is the one hour whose
durable row is knowably behind the disk — so the walk still reads it, once per
process, and a lost tail is recoverable again. A closed hour already walked is
not re-read, which is what keeps that exclusion affordable.

## Consequences

Measured on a synthetic ledger, boot → first locate:

| | today (1 507 hours / 295 k segments) | 28 TB (47 k hours / 8 M segments) |
| --- | --- | --- |
| wire payload before / after | 17.7 MB → **0.4 MB** | 479.3 MB → **11.3 MB** |
| ledger load before / after | 256.5 ms → **2.7 ms** | 12 095 ms → **97.6 ms** |
| longest synchronous block | 256.5 ms → **0.3 ms** | 12 095 ms → **1.6 ms** |
| boot → first locate | 257.7 ms → **3.0 ms** | 12 133 ms → **101.3 ms** |
| heap retained by the load | 135.3 MB → **2.2 MB** | 1 679.9 MB → **51.2 MB** |

What it costs. The first read of any hour pays one point read against the
settings store — milliseconds, and against SQLite rather than the media array,
where an hour-directory `readdir` was measured at ~650 ms under load. A late
finalize into an hour outside the live tail pays one point read once; the live
tail is materialised at boot precisely so the write path's dedup gate keeps
answering from RAM (D49).

What it forbids. No caller may read `SegmentHourRow.paths` without checking
`pathsResident`, and no write may be derived from a row that fails the check —
that write would persist "the one path that just arrived" as the hour's
complete set, destroying up to 360 segments of durable record.

What must now be true elsewhere. The durable hour row is the detail authority
for a **closed** hour, so the hour persist must still be write-through per
finalize *for the hour still being written*. Coalescing it is now safe and was
not before — the live hour is served from the disk walk and from the live
writer's own `addSegment`, never from T3 — but coalescing is a separate change
and is deliberately not made here.

D148 is untouched: an unread hour is never forgotten, and eviction still
confirms before the ledger drops anything.

## Enforcement

`packages/addon-pipeline/src/recorder/addon/__tests__/segment-hour-boot.spec.ts`
asserts the **statement**, not only the outcome: the boot query's `columns`
equals the projection and does not contain `paths`, and no record any boot query
returns carries a `paths` key. An outcome-only test cannot see the difference —
a boot that fetched paths and discarded them in JS passes it and is still the
OOM, which was verified by disarming the projection and watching the outcome
test stay green.

The same file pins the yield bound (longest synchronous run ≤ the chunk), the
`pathsResident` refusals on all four write paths, and that a failed T3 read
leaves the durable rows byte-identical.
`hydrate-window-ledger-first.spec.ts` pins the ledger-first order, the live-hour
exclusion and the closed-hour skip. `segment-hour-ledger.spec.ts` fails the
build if `hydrateIndex` reappears in the recorder addon or if any
`hydrateWindowFromStorage` call site stops passing the ledger.
