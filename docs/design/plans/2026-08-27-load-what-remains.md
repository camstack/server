---
title: Load — what remains, in order of payoff
covers:
  - packages/system/src/kernel/heap-watch.ts
  - packages/addon-pipeline/src/recorder/addon/segment-writer.ts
  - packages/addon-pipeline/src/recorder/recording-index.ts
---

# Load — what remains

Measured follow-up of the 2026-08-27 session. The starting measurements live in
**[architecture/load-ledger.md](../../architecture/load-ledger.md)**; every item
below **must** write its own before/after there before calling itself closed.

## The ordering principle

Items are ordered by **how much they make the NEXT problem cheaper**, not by how
much they save today. A defect that produces no signal costs twice: once when it
happens, and once when it is hunted by hand.

And the rule that holds for all of them, without exceptions: **the assertion
verifies what is asked — one query instead of N, one sum instead of a scan —
never the result.** An identical result is precisely what allowed four different
defects, in a single day, to survive for months against a green suite.

---

## Track A — make the mute failures speak

This track saves almost nothing. It changes **what the system is able to tell
you**, which is why it comes first.

### A1 · The memory guardian cannot see Buffers

`packages/system/src/kernel/heap-watch.ts` (lines 374-376) computes
`stranded = rss − heapUsed − external`: **`external` is subtracted by
construction**, so the watch is blind exactly on the quantity that killed it. It
let **11.4 GB** through without a warning, until a host OOM that froze the
container for **154 seconds**.

The defect is not the number: it is that *stranded* means two different things
depending on the process. On the recorder the growth is V8 heap; on
stream-broker it is Buffers in the glibc heap; on hub-main it is native mappings
already freed. **A single formula cannot watch them all**, and the one that
exists watches one and stays silent on the other two.

What is needed is a threshold that looks at **`rss` against a budget declared per
process**, with the breakdown (`heapUsed` / `external` / rest) in the line, so
the warning also says *what kind* of growth it is. And it must be proven by
disarming it on a load that grows only in `external`: today that test does not
exist, and it is the reason the defect got through.

**Does not fix**: it reduces nothing. It makes visible.

### A2 · The segment writer throws away the reason

`packages/addon-pipeline/src/recorder/addon/segment-writer.ts`, lines 228-236.
**1,594 restarts in 12 hours** = 2.2/min. `exitCode` and the stderr tail are
**captured** (`:117-141`) and printed **only** on give-up (`:208`) and
`spawn-error` (`:181`). For `reason=exit` — the only one that is happening —
there is **no line saying why**.

Three overlapping defects, and they must be closed together or the second stays
invisible:

1. **The reason must be logged on the `exit` branch.** The caller already has it
   in hand.
2. **`STABLE_RUN_MS = 30_000` resets the counter** (`:174`), and the observed
   `ranMs` are almost all above it: `attempt` stays 1, `onGaveUp` never fires,
   and **the storm can last forever without the controller seeing it**. It needs
   a window that counts restarts *regardless* of the length of the run.
3. **Every restart rewrites ~10 s of media already on disk** (the URL carries
   `withRecordingIntent`, so the broker serves the pre-roll at every dial), and
   `-segment_list live.m3u8` is opened in truncation at every spawn: the segment
   open at the moment of death is **named by no playlist** and stays orphaned
   until the runner boots. The only pruner of duplicates was called solely by the
   unreachable walk **now removed**, so today no pruner exists anymore. The
   precedent of this class cost **179 GB**.

This is both a load problem **and a data integrity problem**, on a disk already
under contention.

**Does not fix**: knowing why ffmpeg dies does not make it stop. But without it,
the correction is not even formulable.

### A3 · Declared and dead entities

`listSnoozes` is `caller: 'required'`: from an addon it has no caller identity,
so the snooze entity exported to HA **can never have a value**. It is D62 for the
fourth time in three days, after `audioThresholdDbfs`, the HA entities without a
source and the log channels.

Either a read servable without a user is exposed, **or the entity is retired with
its reason**. What cannot remain is declared-and-mute.

Together with it: `recording.getStorageUsage` has no provider on `agent-a`
nor on the Mac, so the disk entities of those nodes stay `unknown` — cosmetic,
but it must be said or retired in the same way.

---

## Track B — cost proportional to the wrong thing

### B1 · The recorder index stays fully hydrated

**1,606 MB of JS heap ≈ 7.1 M rows.** The CPU half is closed (a `SUM` instead of
a scan, a `LIMIT` instead of a `toSorted`) and removed ~13.5 M visits and ~162 ms
of main thread **per minute**. The memory **did not move**, and the reason is
precise: the scans **depended on** the resident archive, they did not **cause**
it.

The real retainer is `SegmentHourLedger.hydrateIndex(this.index)` at boot
(`recorder/addon/index.ts:1454`), which pushes **every** hourly row into the
index. ⚠ The log line forty lines further down — `full-archive index walk
skipped {reason:'on-demand-windows'}` — **is true and misleading**: it talks
about the walk on *disk*. The index is populated all the same, from SQLite. It
fooled two analyses.

Making it truly lazy means limiting the re-seeding to a recent window **and**
answering from the database for the other four readers that today presuppose the
complete archive: `piles()` (needs a `GROUP BY` that the new aggregation does not
have), `accounting(deviceId)` + `segmentsOnLocation` in `getStorageUsage`, the
hourly retention pruning (`recording-provider.ts:1111` — it would **under-prune**
with a partial index), and the fallbacks of `getAvailability` /
`getDaysWithRecordings`.

⚠ **The risk is silent and must be pinned**: a reader that presupposes the
complete archive, served by a partial index, **does not fail — it under-reports**.
Every converted reader needs a test that asserts the completeness of the answer,
not its absence of errors.

**Does not fix**: the second copy of the path strings in the ledger mirror
(`loadLimit: 100_000` hourly rows) is an independent retainer.

### B2 · The same sum asked twice a minute

`relieveToUsageCap` queries `getEvictableUsage` **unconditionally every 60 s for
every location with a cap**, with no per-physical-device dedup on the first pass.
Two locations aliased on the same root **both** pay — and compute the **same**
domain total, because `domainOf` widens each to the whole domain. One identical
query wasted per minute, forever.

The *breach* path already has the dedup (`getLocationDeviceKey`), and it is
deliberately permissive. The **usage cap** path does not.

⚠ It is also operator configuration (`maxUsedGb` on two locations): the
correction is in the code, but it must be verified with the operator whether the
aliasing is intended.

### B3 · The unbounded reads of post-analysis

Three, all of the same shape — **the question is asked after loading everything,
instead of before**:

- `store/plate-store.ts:161-169` — no `limit` in the filter; the `limit` at
  `plate-gallery-provider.ts:225` truncates the **response**, never the scan.
  Faces already have the cap (1,000), plates do not.
- `store/identity-store.ts:328` — `listSamplesForReembed({ filter: {} })` called
  by a **60 s** timer (`index.ts:4701`): full re-read of `identity_samples`,
  **embedding JSON included**, *before* deciding whether it is needed. The
  freshness question is a `COUNT`.
- `suggestFaceClusters` (`face-gallery-provider.ts:722`) scans **all** unassigned
  faces; its `limit` cuts the *clusters*, not the faces. The modal shows a window
  of 100 and pays a scan of the entire corpus.

### B4 · The frame allocated before knowing whether it is needed

`resolvePinnedFrame` is called **before** the `request()` to the scheduler
(`index.ts:6461` versus `:6463`; `:8037` versus `:8047`): **discarding a request
never avoids the allocation**. And `CaptureScheduler` limits **per-device counts**
(3 and 24) and **no global sum in bytes** — 30 cams × 3 slots × 56 MB ≈ 5 GB
*while staying within the limits as written*.

In addition `EventMediaDispatcher` is built with **raw** transport closures
(`index.ts:2140-2142`), not passed through the scheduler: those fetches have
**no** concurrency limit.

### B5 · The cache slot shared by all cameras

`shared/frame/shared-frame-resolver.ts:24` is **one global slot**. With more than
one camera the hit rate tends to **zero**, and the cost of the attempt remains.
Either it becomes per-camera, or it is removed: a cache that does not catch is
just work.

### B6 · `timelapse-scheduler` without a pool

`:285/310/321` — `Promise.all` over (rule × camera) **without a pool**, each with
~50 MB of MP4 plus ~67 MB of base64 retained for ~4 minutes. It is not the
steady-state retainer, but it is a burst OOM path **proportional to the
cameras**.

---

## Track C — the pre-buffer: keep it, but with a cap

**Operator decision (2026-08-27):** *«il pre-buffer lasciamolo se non esplode; va bene se è proporzionale e costante per numero di camere. Ovviamente non deve esplodere.»* [Let us leave the pre-buffer if it does not blow up; it is fine if it is proportional and constant per number of cameras. Obviously it must not blow up.]

So it is **not a defect to correct**: the permanent synthetic demand on every
`high` stream (`stream-broker-manager.ts:6684`) and the default 10 s of pre-roll
(`pre-roll.ts:213`) stay. Measured: **47 rings for 13 cameras, 898 MB** of
arrayBuffers, 61% of that runner's CPU in garbage collection.

What is **missing** is the cap: `RTP_RING_MAX_BYTES = 24MB` exists **per
instance** (`stream-broker.ts:548`) and **no fleet budget**. It is the exact way
that number grows without anyone noticing — and the two additional rings per
broker (`preBuffer` 10 s, `decoderSeedBuffer` 6 s, the latter fed **without any
subscriber**) have no cap in bytes.

### C1 · A fleet budget, declared and watched

An overall per-node cap on the bytes retained by the rings, with:
- the behaviour at exhausted budget **decided and motivated** — shortening the
  window of the coldest is acceptable, **starving a live session never is**;
- a line when the budget bites, with `tags: { deviceId }`;
- and the proportionality **verified by a test**: N cameras must cost
  N × constant. It is exactly the invariant of the table in the load ledger, and
  here it is the condition the operator set.

### C2 · Balancing the pre-buffer onto other nodes — direction, not plan

Operator idea, recorded because it is the right way out if the cap starts to
bite: **move the pre-buffer of some cameras onto another node** instead of
shortening it.

Before designing it, two answers are needed that we do not have today:
1. **does a remote pre-buffer cost a process crossing at frame-rate?** If so, it
   is forbidden (D9/D18: it is how hub-main went OOM). If the node holding the
   ring is the same one that *dials* the camera, it does not — and then it is a
   placement decision, not a transport one;
2. **who decides?** The balancer already knows node load and capacity; the
   pre-buffer is today a property of the broker, not of placement.

Not plannable until C1 has produced the number: **you do not balance a load you
do not measure**.

---

## Track D — the silent read, the real correction

The plan is already written:
[`2026-08-27-lettura-fallita-non-diventa-un-default.md`](2026-08-27-lettura-fallita-non-diventa-un-default.md).

⚠ **Non-negotiable order**: the additive block goes **to production and is
observed** before touching the contract. Out of ~60 addons, **1** consults the
flag, **1** has a defence of its own, **0** survive if that read starts to throw
— and the agent's boot **depends** on the collapse, with a comment in the code
that says so.

---

## Track E — the guard that would have caught three of today's defects

The load ledger has a table of **invariants**: what the load of each component
*must* be proportional to. For some cases it is verifiable.

A guard that rejects **a fleet read on a per-device path** would have caught,
before they were born: the metadata mirror (it re-read 1,017 rows at every
event), `getChildren` (1,024 RPCs), and the recorder's accounting (6.7 M rows per
call).

Model: `check-recording-trigger-fed.ts` and `check-summary-ladder-reachable.ts`,
both in CI. Feasibility to be evaluated: statically distinguishing "fleet" from
"per-device" requires a naming convention that today exists only in part
(`listAll` / `listFleet` versus `get` / `getMany`). **If it is not statically
decidable, say so and do not write a guard that always passes** — a guard that
cannot fail is worse than no guard.
