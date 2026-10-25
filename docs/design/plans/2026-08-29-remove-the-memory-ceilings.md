---
title: Removing the memory ceilings — the order in which the right to remove them is earned
covers:
  - packages/addon-pipeline/src/recorder/recording-index.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/recording-provider.ts
  - packages/system/src/kernel/heap-watch.ts
  - server/backend/src/main.ts
---

# Removing the memory ceilings

> **The operator's goal, 2026-08-29.** *"L'obiettivo è rimuovere i tetti
> di memoria, sono solo pezze a problemi più profondi così come le variabili
> malloc."* [The goal is to remove the memory ceilings, they are only patches over
> deeper problems, as are the malloc variables.]
>
> **Position, up front.** The goal is right and this plan pursues it,
> but the order is not negotiable: **today the ceiling is not the cure, it is the fuse.**
> The recorder floats at 1.4–1.8 GB against a `heapLimit` of 3,264 MB with an
> index that grows with the disk; remove the ceiling now and that index no longer stops
> at 3 GB — it stops when the container's RAM runs out, and then it is not
> a runner that dies, it is the host, and with it the recordings. **The criterion for
> removing a ceiling is having shown that nothing can reach it**, not having
> decided that it is ugly.
>
> The analysis of the reference NVR
> ([2026-08-29-reference-nvr-recording-model.md](../2026-08-29-reference-nvr-recording-model.md))
> confirms the thesis from the opposite side: **they have no ceiling at all and do not
> need one**, but for a structural reason — nothing they retain is
> O(archive). The absence of the ceiling is a *consequence*, never a choice that can be
> copied on its own.

Reference documents, to be read before touching anything in here:
[recorder-index-at-scale](../2026-08-29-recorder-index-at-scale.md) (the scaling
law and the staged plan) and
[reference-nvr-recording-model](../2026-08-29-reference-nvr-recording-model.md)
(what is really transferable and what is not).

---

## 0 · The three ceilings, and what each one hides

| Ceiling | Where | What it really masks |
| --- | --- | --- |
| `--max-old-space-size=3072` on the recorder runner | runner command line | a per-segment index of the whole archive, resident, sized by the disk |
| `rssBudget` 3,103 MB (recorder) / 4,096 MB (hub-main) | manifest / `HUB_MAIN_RSS_BUDGET_MB` | for the recorder the same index; for hub-main **we do not know yet** — the telemetry has just been repaired and is not shipped yet |
| `MALLOC_ARENA_MAX=2` | container environment | glibc pages freed and never returned: **cosmetics on the RSS**, not oxygen — that memory is reusable by the same process |

And a patch that is not a ceiling but behaves like one: the **reclaim** in
`heap-watch` (`packages/system/src/kernel/heap-watch.ts`), a synchronous `gc()`
forced when a threshold is exceeded. It does not reduce allocations, it adds a
stall and flattens the symptom precisely in the window in which you would want to
see it. It is our home-grown version of the reference NVR's periodic GC — which
however is load-bearing for them (it drives the finalisation of the RPC proxies) and for us it drives
nothing, because `ctx.api` passes capability calls, not object
proxies.

---

## 1 · Stage 1 — done, in production (`1.2.141`)

The five CPU fixes of `recorder-index-at-scale` §7, shipped on 2026-08-29.
They do not touch residency: they serve to remove churn and to **discriminate**.

Measured, not estimated:

- incremental hourly aggregate: parses per hour **64,980 → 360**, and **1,459,486 →
  1,708** in an hour of restart storm; hour construction 21.8 → 8.1 ms, storm hour
  471 → 121 ms.
- reads: point lookup 40.9 → 0.35 µs, `coveredEdgeBefore` 36.4 → 0.33 µs,
  60 s window 90.2 → 0.77 µs, `getStorageUsage` census **26.75 ms →
  6.8 µs**. Allocation per operation **29.7 KB → 0.1 KB** on the segment
  read, 33.9 → 0.5 KB on the window.

**Baseline to beat** (`scratchpad/recorder-stage1-baseline.md`): `heapUsed`
floor at boot+5 min **1,384 MB**, steady-state `loopMax` **2,046–2,781 ms** with
`loopP99` stuck at 21–28 ms, `external` ≤ 15 MB.

### OUTCOME — the falsifier came true (measured 2026-08-29 12:31)

Stage 1 is the experiment, and the experiment said **no**. `[mem]` series
after the 09:56 deploy:

| | before (baseline) | after stage 1 |
| --- | --- | --- |
| `heapUsed` floor at boot+~10 min | 1,384 MB | **1,844 MB** |
| steady-state `heapUsed` | 1,361–1,815 MB | **1,439–1,593 MB** |
| steady-state `loopMax` | 2,046–2,781 ms | **1,740–2,881 ms** |
| `loopP99` | 21–28 ms | 21–24 ms |
| `external` | 3–15 MB | 4–6 MB |

**Nothing changed.** The micro-benchmark gains of stage 1 are real
and measured, and they are not visible in the process: so **they were not the source**.

A confounder to name, because it narrows the field instead of widening it: the
fixes of batch B sit on the **read path**, and pay off only when
someone reads. The heap however fills to ~1.6 GB within five minutes of boot
anyway — so the growth **does not come from reads**. What remains is the write path,
or something periodic that we have not yet identified.

Operational consequence, as foreseen by `recorder-index-at-scale` §9: there is a retained
set that nobody has named, **the "55–70 MB" sizing of stage 3 is built on
sand**, and **the heap snapshot becomes mandatory** before stage 3. The snapshot is
an admin mutation: it must be requested from the operator.

Note: `cpuGcPercent` is not usable as a criterion — in the same sample it
reads `0` for the recorder and `null` for pipeline-analytics, and for hub-main a
value higher than the total CPU. We must understand what it measures before citing it.

---

## 2 · Stage 2 — lean boot. Prerequisite to the 30 TB array

Load of the T1 level only with a `columns` projection (no `paths`), in chunks
with yield; the archive replay in `hydrateIndex` is gone; the hours known to the ledger
become *hydratable from T3*, not `hydrated`, and the first read pays a
point read.

**What the NVR adds.** Their boot **enumerates and repairs nothing**: it opens a
new session and the discontinuity is *represented*, not reconstructed. It is
independent proof that the strong form of stage 2 is acceptable in a
product that someone pays for: the honest answer to "what happened before I
started" is the `unknown` state of the tri-state, derived on request.

**Attention, dependency discovered from stage 1A.** Today `hydrateIndex` marks
every ledger hour `hydrated` and `hydrateWindowFromStorage`
(`packages/addon-pipeline/src/recorder/addon/roots.ts:350`) exits immediately on
a hydrated hour. As long as that holds, **a lost tail is not "under-reported": it is
invisible forever** to playback and timeline. Stage 2 removes precisely that
mark — and that is why it also unblocks the coalescing of persistence
(69 of the 121 ms of the storm hour are by now just `JSON.stringify`, plus
~3.6 GB/day of rewrites towards the checkpoint). **Coalescing is done after
stage 2, never before.**

Measures: boot→first locate, heap at boot, ms of ledger loading.

### OUTCOME — shipped in the tree on 2026-08-29 (D287)

Measured on a synthetic ledger at the two sizes, boot → first locate:

| | today (1,507 hours / 295 k segments) | 28 TB scenario A (47 k hours / 8 M segments) |
| --- | --- | --- |
| payload on the wire | 17.7 MB → **0.4 MB** | 479.3 MB → **11.3 MB** |
| ledger load | 256.5 ms → **2.7 ms** | 12,095 ms → **97.6 ms** |
| longest synchronous block | 256.5 ms → **0.3 ms** | 12,095 ms → **1.6 ms** |
| boot → first locate | 257.7 ms → **3.0 ms** | 12,133 ms → **101.3 ms** |
| heap retained by the load | 135.3 MB → **2.2 MB** | 1,679.9 MB → **51.2 MB** |

**One thing this plan had not foreseen.** The LIVE hour cannot be
served from T3: its durable row is by construction behind the disk,
so serving it from the ledger would rebuild, one level down, the same invisibility
that the `hydrated` mark at boot created. It is excluded from the ledger-first path
and continues to be walked, once per process; an already-walked
CLOSED hour is not re-read, and that is what makes the exclusion
sustainable.

**Coalescing is now unblocked and has NOT been done**: the live hour
is served from the disk walk and from the current writer's `addSegment`s, never from T3,
so delaying its persistence is no longer visible to playback and timeline.
It remains a separate change, with its own measurement.

---

## 3 · Stage 3 — residency. This is where the ceiling stops being needed

T2 with an LRU cap on the resident hours; the mirror loses the `paths`; T3 as the source
of the cold detail, with readdir as a fallback. Index heap **55–70 MB
independent of the archive size**.

**Two grafts from the NVR, both small and to be done here.**

1. **The reader repairs the durable index it has just rebuilt**
   (NVR §4.2). In their case, a missing hourly rollup is rebuilt from the sidecars
   **and rewritten**, but only for closed hours. In ours the storage fallback
   (`roots.ts:388`) feeds the in-memory index via
   `packages/addon-pipeline/src/recorder/recording-index.ts:317` and **stops
   there**: nobody upserts the rebuilt hour row. Today it is a waste;
   under T2 eviction it becomes **load-bearing**, because an hour without a ledger row
   would pay a readdir at every eviction, forever. Constraints: only **closed**
   hours, and a read must never become a durable write
   on the live hour.
2. **Derived artifacts under the same key as the source**
   (NVR §4.3). In their case a generated thumbnail lives inside the directory of the hour
   it depicts, under a hash of the parameters: it has no lifetime, no
   eviction policy, no orphan sweep — it disappears when the hour disappears. We
   delete per segment, so the placement needs thought;
   but the **invariant** must be imported: *a derivative is addressed under the key
   of the source it derives from, so the retention decision that removes the
   source removes it too*. Every derived cache with a life of its own is a future
   orphan sweep. To be checked against the still/thumbnail level **before**
   it grows.

Precondition to verify before starting: **where the settings store's SQLite
physically lives.** If it shares the media array, cold point reads
inherit the array's latency and the design degrades to today's behaviour
(`recorder-index-at-scale` §10).

---

## 4 · Stage 4 — the last walks over the whole archive

Retention `selectEvictions` with an hourly flow bounded per device; derivation of
profiles and days from T1; `piles` / `accountingByProfile` from T1. After this,
nothing in the recorder is O(archive) on a hot path.

**What we do NOT take from the NVR, and why.** Their "fair" victim order
(four passes anchored to the global oldest) exists because they have no
index. **Our strict oldest-first (`evict-select.ts:6`) is better precisely
because we have the index that they lack.** The same goes for the
no-database approach: it works only because their only question about the whole archive
is free space — we ask for bytes and oldest-per-device, placement,
rebalancing, eviction domains.

On the **throwaway worker** (NVR §4.1): we adopt the principle — transient bulk
memory must not accumulate in a long-lived runner — and **reject the mechanism**,
because stages 2–4 make the walk not happen. Where
a walk really remains (operator-armed footprint rescan,
ledger reconcile after a trusted walk) the vehicle already exists and is
`pipelineRunner.runStatelessStep`, node-pinned and bounded. New processes are not
forced: D2.

---

## 5 · Stage 5 — removing the ceilings, in order

Only here, and only with the proofs in hand. **Every removal has a measured
entry condition, not an opinion.**

| # | What is removed | Entry condition (measured) | If the condition does not hold |
| --- | --- | --- | --- |
| 5a | the **reclaim** in `heap-watch` | none: it does not reduce allocations, adds stall, masks the symptom. It can be removed **right away** — it is a pure patch, not a fuse | — |
| 5b | `--max-old-space-size` of the **recorder** | stage 3 in production **and** `heapUsed` flat with respect to the archive size over at least 7 days with the array attached, **and** steady-state `loopMax` under 200 ms | the ceiling stays and the retained set is hunted with a snapshot |
| 5c | `rssBudget` of the recorder | as 5b: a budget on a process that cannot grow has no job | same |
| 5d | `MALLOC_ARENA_MAX` | after 5b/5c, and only if the steady-state RSS is within twice `heapUsed`. It is last because it is the one that matters least: it changes **whether** the allocator returns already-free pages, not how many we ask for | it is left, documenting that it is cosmetics on the RSS |
| 5e | budget and ceiling of **hub-main** | the telemetry must be **shipped and read** (`@camstack/server` train), then what allocates must be identified. Today hub-main goes 2.5 → 3.1 GB in 42 minutes and the composition is not measured | nothing is touched: without a measurement, removing hub-main's ceiling is removing the fuse from the process that mediates every call |

**Note on reading `cpuGcPercent`.** A 2026-08-29 sample reads
hub-main at `cpu=139` and `gc=246.8` — GC higher than the total, so the
"percentage of one core" interpretation is wrong. **It must be established what that
field really measures** before using it as a criterion in 5e.

---

## 6 · Outside this plan, but quantified

**Segment duration is a free multiplier on the index** (NVR §4.4).
The rows are `writer × days × (seconds per day ÷ seconds per segment)`:
lengthening the segment divides every number in the projection by the same factor,
on the resident and on the durable side. Their segments are about six times ours, and
our seek via `mfra` is **exact** where theirs is sampled — so seek
resolution is not the reason ours are short. But it is not
free: resolution of the gaps in the timeline, eviction granularity, loss on
unclean shutdown, export unit and redundancy-sweep unit. **It must be evaluated on
its own** (see `segments-60s.md`) and **never as a substitute for the residency
limit** — the residency limit must hold at any segment
duration.

---

## 7 · What falsifies this plan

- **The `heapUsed` floor survives stage 1.** Then churn was not the cause
  and the snapshot precedes stage 3.
- **Point reads on T3 are not milliseconds** (settings DB on the array,
  or checkpoint contention D96): T2 eviction eats the feeder's budget.
- **`loopMax` beyond 2 s persists after stages 1 and 2 with a small heap.** Then
  the stalls were not GC and there is something synchronous and periodic not yet
  identified: profile before proceeding.
- **A new caller that demands per-segment detail over the whole archive
  synchronously.** It would have to be built paginated by necessity, or it breaks T2.

---

## 8 · Known pending items that this plan does not resolve

- **2,131 ghost segments (15 GB)** on `recordings:high`, a locationId that
  no longer resolves: invisible to eviction, they falsify `oldestMs`. Reconcile
  once.
- **Storm hours with overlapping duplicates** (an hour row with 1,708
  segments against a maximum of 360): the redundancy sweep is bounded to the
  lookback and will not revisit them.
- **`segmentAt` is wrong on overlap** — **FIXED on 2026-08-29**
  (executive plan §P6). It took the last row that starts before the instant and
  stopped, so where a short segment starts inside a long one that covers it
  it **reported a gap over footage that exists**. It now walks backwards under
  `maxDurMs` as `segmentsOverlapping` and `coveredEdgeBefore` already did
  (`packages/addon-pipeline/src/recorder/recording-index.ts:712`).
- **`settings-store.aggregate` has no `groupBy`**: per-device totals remain N
  calls until a framework train brings the extension.

---

## 9 · The stage 1 question has a measured answer (2026-08-29, 10:57Z)

The full report, with the arithmetic of every suspect, is in
[recorder-heap-what-is-retained](../2026-08-29-recorder-heap-what-is-retained.md).
In brief, and without having taken any heap snapshot:

- **It is the retained set, not churn (hypothesis (a)).** The `heap-watch`
  reclaim — a compacting `gc({ flavor: 'last-resort' })`
  (`packages/system/src/kernel/heap-watch.ts:656`) — fired on the recorder
  at 10:10:45Z: `stranded=1029MB rss=2478MB→1971MB freed=507MB took=1005ms`.
  The `[mem]` sample 40 s later reads `heapUsed=1439MB heapTotal=1870MB`. **The
  live set after a forced compaction is ≥ ~1.37 GB.** Confirmed by three other
  independent lines: 0 samples out of 75 between 416 MB and 1231 MB in eight process
  lives; every other runner on the hub sits between 39 and 160 MB of `heapUsed`, and the
  same `recorder`s on the agents (same build, zero cameras) sit at 52 MB.
- **It is not the index, and it is not the mirror.** Archive read live: **1,515 hour
  rows, 296,084 segments, 1.089 TB**. At the two calibrations that the repo itself
  carries in source (203 and 226 B/row) the index is **60–67 MB, 4% of the
  heap**. The `DurableLedger` mirror costs **~1.5 MB marginal**, not
  100–200: the path strings are **the same ones** the index holds
  (`segment-hour-ledger.ts:400` → `recording-index.ts:317` → `rowFor`,
  `recording-index.ts:223`). Stage 3's «the mirror loses the `paths`» remains
  right as hygiene, **it is not a memory lever**.
- **Everything this pass managed to quantify sums to 115–125 MB,
  less than 9%.** ~1.35 GB does not have a name yet.
- **The cheapest experiment is not a snapshot.** The runner already computes
  `v8.getHeapSpaceStatistics()` (`addon-runner.ts:758`) and **welds it into the
  same handler** as `writeHeapSnapshot` (`addon-runner.ts:768`): today the free
  answer cannot be obtained without the expensive one. **Separating them** (~5
  lines) and putting the heap-spaces on the `[mem]` heartbeat halves the search:
  large `old_space` ⇒ millions of small objects; large `large_object_space`
  ⇒ a handful of huge objects. If the snapshot is then really needed, it must
  produce **the 10 retainers by retained size attributed to the class field
  that roots them** — not another observation about `old_space`.
- **Careful with 5a.** The reclaim is a "pure patch" on `pipeline-analytics` (every
  120 s, with the `STEADY STATE` warning printed four times today). On the
  recorder it fired **once in six hours**, and it is the tool that produced
  the measurement above: removing it before having named the retainer
  throws away the only cheap probe in production. 5a must be written naming the
  process.
- **Two collateral findings.** (1) `qualifyObjectTrigger`
  (`packages/addon-pipeline/src/recorder/object-trigger.ts:74`) rejected **394
  events out of 394** as `malformed` at 3.3–3.9/s. **FIXED the same day: the
  trigger fired.** That topic is shared by three emitters (object, motion
  and audio) and only the first carries `className`; the consumer's private
  interface demanded it from all, so motion and audio ended up in the
  `malformed` bucket — the only reason that means "the emitter has
  drifted" — and saturated it. Now the envelope is validated, discrimination is on `kind`, and
  a total-rejection regime is reported per camera. (2) `EventMap` was
  write-only: `prune()` and `events()` with no callers, a marker with
  the raw `regions` retained for every motion event. **Deleted**, not
  wired up — ADR-0194 had already refused to build the reconcile on top of it.
