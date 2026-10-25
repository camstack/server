---
title: The recorder's 1.4 GB — retained, not churn, and not the index
last-verified: 2026-08-29
covers:
  - packages/addon-pipeline/src/recorder/recording-index.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/durable/durable-ledger.ts
  - packages/addon-pipeline/src/recorder/segment-path.ts
  - packages/addon-pipeline/src/recorder/mfra-capture.ts
  - packages/addon-pipeline/src/recorder/addon/heap-delta.ts
  - packages/addon-pipeline/src/recorder/addon/calendar-index.ts
  - packages/addon-pipeline/src/recorder/addon/calendar-hour-cache.ts
  - packages/addon-pipeline/src/recorder/addon/segment-watcher.ts
  - packages/addon-pipeline/src/recorder/addon/ffmpeg-args.ts
  - packages/addon-pipeline/src/recorder/storage-evictable-provider.ts
  - packages/addon-pipeline/src/recorder/still/still-frame-service.ts
  - packages/system/src/kernel/event-loop-stall-monitor.ts
  - packages/system/src/kernel/moleculer/addon-runner.ts
  - packages/system/src/kernel/heap-watch.ts
---

# The recorder's 1.4 GB — retained, not churn, and not the index

> **The question.** Stage 1 shipped five measured CPU/allocation fixes
> (`@camstack/addon-pipeline@1.2.141`, 09:56Z) and the `heapUsed` floor did not
> move. `remove-the-memory-ceilings` §1 recorded the falsifier as having fired
> and asked the next question: is the recorder holding **a large retained set
> plus normal churn**, or is it **a very high allocation rate whose garbage V8
> lets accumulate into a sawtooth**? They lead to opposite fixes.
>
> **Answer, up front. It is the retained set, and it is measured, not
> inferred — no heap snapshot was taken.** A forced full compacting GC ran on
> this process at 10:10:45Z and left it holding ~1.44 GB. Of that, everything
> this pass could price sums to **115–125 MB (< 9%)**. The segment index — the
> structure both design documents are built around — is **60–67 MB, 4% of the
> heap**. The `DurableLedger` mirror, §4's headline suspect, is **~1.5 MB**.
> **The retainer is not named**, and §4 below states the cheapest experiment
> that would name it: a five-line split in `addon-runner.ts` that stops welding
> the free heap-space breakdown to the expensive heap snapshot.

Method: read-only tRPC (`scripts/hub/hub.mjs`) + Loki, 2026-08-29 09:50–10:57Z.
No production SQLite was opened, no snapshot taken, no hub state changed.

---

## 1 · The discrimination — four independent lines, all pointing at "retained"

### 1.1 The distribution of `heapUsed` has a hard floor and no low tail

75 `[mem]` samples for `hub/recorder`, 06:46→10:41Z, spanning **eight process
lifetimes** (pids 67416, 2330966, 2332994, 2764147, 2764329, 3008564, 3008743,
310, 1707241).

| Phase | `heapUsed` values seen |
| --- | --- |
| First sample after each boot | 114, 118, 173, 186, 186, 187 MB |
| Second sample (boot + ~5 min) | 219, 416, **1231, 1253, 1384, 1568, 1666** MB |
| Every steady-state sample thereafter | **1231 – 1921 MB** |
| Between 416 MB and 1231 MB | **zero samples, out of 75** |

The sampler demonstrably *can* read low values — it reads 114 MB. It stops
reading them the moment the process is warm, permanently, across eight
independent process lifetimes. If the heap swept from a small live set up to
the observed ~1.85 GB peak, a sample landing uniformly in that cycle would fall
below 1.2 GB more than half the time; 0 out of ~60 steady-state samples is
p ≈ 0.45⁶⁰.

### 1.2 A forced full compacting GC did not move the floor

`heap-watch`'s reclaim is a synchronous `gc({ execution: 'sync', flavor:
'last-resort' })` (`packages/system/src/kernel/heap-watch.ts:656`), armed when
`rss − (heapTotal + external)` exceeds 1024 MB
(`packages/system/src/kernel/heap-watch.ts:209`). It fired on the recorder
**once** in six hours:

```
10:10:45Z  [mem] reclaim hub/recorder stranded=1029MB rss=2478MB→1971MB
                 freed=507MB arrayBuffers=0MB→0MB took=1005ms
10:11:25Z  [mem] hub/recorder rss=1988MB heapUsed=1439MB heapTotal=1870MB
                 external=5MB arrayBuffers=2MB
```

A last-resort GC compacts and hands pages back — it returned 507 MB of RSS in
the same second. Forty seconds later V8 still had **1870 MB committed and
1439 MB of it in live objects**. At the steady-state allocation rate implied by
the sawtooth (§1.4, ~1.7 MB/s) those 40 seconds account for ~70 MB. **The live
set is ≥ ~1.37 GB, measured, with no snapshot.**

### 1.3 It is not the runner shell, and it is recorder-specific

Every runner on the hub, one 12-minute window (`[mem]`, 10:44–10:56Z):

| node | rss | **heapUsed** | heapTotal | external | arrayBuffers | loopMax |
| --- | --- | --- | --- | --- | --- | --- |
| `hub/recorder` | 2213 | **1542** | 1972 | 5 | 2 | 2804 ms |
| `hub/provider-reolink` | 482 | 160 | 257 | 52 | 33 | 32 ms |
| `hub/pipeline-analytics` | 1796 | 159 | 291 | 22 | 6 | 113 ms |
| `hub/stream-broker` | 1232 | 111 | 234 | 758 | 753 | 62 ms |
| `hub/sqlite-settings` | 704 | 60 | 167 | 12 | 9 | 444 ms |
| `hub/decoder-ffmpeg` | 128 | 39 | 50 | 6 | 1 | 25 ms |

And the control that matters: the **same addon build** runs as `recorder` on
both agents, with no cameras and no archive. Both sit at **`heapUsed` 52 MB,
`loopMax` 30–176 ms**. So the runner shell is ~50 MB of heap, and ~1.45 GB is
recorder-addon state that exists only where there are writers and an archive.

Note also that the two other 1 GB+ processes on this hub are *not* JS-heap
cases: `pipeline-analytics` holds 1796 MB of RSS against 159 MB of heap, and
`stream-broker` holds 758 MB in `external`. Only the recorder's is heap.

### 1.4 Stage 1's own result is the fourth line

Stage 1 removed the read-path copies and the O(N²) hour aggregate — real,
micro-benchmarked reductions in allocation *rate*. The floor moved from
1384 MB to 1439 MB, i.e. not at all. A sawtooth's trough is set by the live
set and its peak by the allocation rate; cutting the rate would have visibly
lowered the peak and lengthened the period. Neither happened. Churn was never
what held the floor up.

**Verdict: (a), a large retained set. Confidence: high** — four independent
lines, one of which (§1.2) is a direct measurement of the post-compaction live
set rather than an inference.

**What the churn actually is, for completeness.** The V8 helper pool
(`cpuGcPercent` — concurrent marking and sweeping, see
`packages/system/src/builtins/native-metrics/thread-cpu-sampler.ts:21` on what
that field really contains) reads 0.1–0.3% of a core in most one-minute
buckets and spikes to 16–48% roughly every 3–10 minutes, **identically before
and after the deploy**. Peak-to-trough within a `[mem]` window is ~400 MB
(1844 → 1439), so a major GC every ~4 minutes reclaiming ~400 MB puts steady
allocation at **~1.7 MB/s**. That is the "normal churn on top" half of (a), and
it is small.

---

## 2 · The archive, read live — and the arithmetic that clears the index

Read 2026-08-29 from `settingsStore.count` / `settingsStore.aggregate` on
`recorder:segment-hours`:

| Fact | Value |
| --- | --- |
| Hour rows | **1 515** |
| Segment rows | **296 084** |
| Footage bytes | **1 089 056 627 570** (1.089 TB) |
| Oldest `minStartMs` / newest `maxStartMs` | 1786768055000 / 1788000914000 |
| `recorder:exports` rows | 80 |
| `recorder:ops-log` rows | 505 |

### The index is 4% of the heap

> **SUPERSEDED 2026-08-29, same day — see §7.1.** The per-row calibration
> below is right; the row COUNT it multiplies is not. `sortedViewCensus` was
> wired to the sweep that afternoon and reports **2 032 rows allocated in a
> 66-minute lifetime**, not 296 084 — D287 removed the boot walk, so the index
> holds only what the process has touched. The index is **0.44 MB, 0.03 % of
> the heap**, and this section's 60–67 MB should not be quoted again.

The repository has calibrated `SegmentRow` cost **twice, independently, on
production shapes**, and both numbers are in the source:

- `packages/addon-pipeline/src/recorder/recording-index.ts:213` — 26 cameras ×
  2 profiles × 12 days = 5.39 M rows, 1218 MB held → **226 B/row**.
- `packages/addon-pipeline/src/recorder/segment-path.ts:28` — 17 cameras ×
  2 profiles × 12 days = 3.53 M rows, 717 MB → **203 B/row**.

296 084 × 203–226 B = **60–67 MB**.

Inverted: for the index to *be* 1.44 GB it would have to hold **~6.9 M rows**,
23× the archive the ledger and the storage accounting both report. It does not.

### The `DurableLedger` mirror is ~1.5 MB, not 100–200 MB

`recorder-index-at-scale` §4 item 4 makes the mirror
(`packages/addon-pipeline/src/durable/durable-ledger.ts:175`) the headline
suspect: "the mirror keeps every path string of the archive alive forever". The
first half is true and the conclusion drawn from it is not, because **those are
the same string objects the index already holds.**

The chain: `SegmentHourLedger.hydrateIndex`
(`packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:400`) hands
`hour.paths` verbatim to `RecordingIndex.hydrateHour`
(`packages/addon-pipeline/src/recorder/recording-index.ts:317`), which builds
each row through `rowFor`
(`packages/addon-pipeline/src/recorder/recording-index.ts:223`) and stores the
loop variable — the mirror's own string — as `SegmentRow.path`. That reuse is
precisely what the docblock at `recording-index.ts:213` exists to protect.

So the mirror's **marginal** cost is only what the index does not already pay:

| Term | Arithmetic | Bytes |
| --- | --- | --- |
| `paths` FixedArray slots | 296 084 × 4 B (pointer compression) | 1.18 MB |
| Hour row objects + boxed doubles | 1 515 × ~116 B | 0.18 MB |
| Mirror `Map` entries + key strings | 1 515 × ~70 B | 0.11 MB |
| **Total** | | **~1.5 MB** |

Even if the sharing were ever broken, a second copy of every path string is
296 084 × ~72 B = **21 MB**. Stage 3's "the mirror sheds `paths`" is correct as
design hygiene and worth ~1.5 MB today; it is not a memory lever, and the
"+100–200 MB mirror" line in `recorder-index-at-scale` §2's 30 TB projection is
over-stated by roughly 4× for the same reason (at 8 M paths the slot term is
32 MB, not 100–200 MB).

---

## 3 · Every other suspect, priced

**Boot load — garbage, not a retainer.** `DurableLedger.load`
(`packages/addon-pipeline/src/durable/durable-ledger.ts:220`) is one query for
1 515 rows whose `paths` blobs total ~16 MB of JSON; `recordToRow`
(`segment-hour-ledger.ts:301`) re-`JSON.parse`s each blob and `segmentHourRow`
folds `hourAggregate` over all 296 084 paths. **~35–50 MB of transient
garbage, 0.3–0.6 s of blocked loop.** It cannot be the floor: the last-resort
GC of §1.2 would have taken all of it.

**Write path at ~3.4 finalizes/s — the largest rate I could price, and it
retains nothing.** Per finalize, `appendSegmentPath`
(`segment-hour-ledger.ts:183`) copies the hour's `paths` array (mean 180 slots
× 4 B ≈ 0.7 KB) and `rowToValue` (`segment-hour-ledger.ts:287`)
`JSON.stringify`s it (mean ~10 KB, ~20 KB at a full 360-segment hour). That is
**~37 KB/s ≈ 3.2 GB/day** — the "~3.6 GB/day of row rewrites" already named in
`remove-the-memory-ceilings` §2. The string is handed to one `set.mutate` and
dropped. At 37 KB/s it takes **11 hours** to allocate 1.4 GB; the process gets
there in 5–10 minutes and then stops. Real churn, not the floor.

**Periodic work.**

| Timer | Cadence | What it touches | Priced |
| --- | --- | --- | --- |
| Segment watcher (`addon/recording-controller.ts:269`) | 2 s **per writer** | re-parses the WHOLE `live.m3u8` every tick (`addon/segment-watcher.ts:167`) | see below |
| Export sweep (`addon/index.ts:234`) | 5 min | reads the whole export history (`addon/export-janitor.ts:28`) — **80 rows**, ~40 KB/pass | negligible |
| Retention sweep (`addon/index.ts:240`) | 1 h | one pass ran and completed in the boot window | not the floor |
| Redundancy sweep (`addon/index.ts:242`) | 1 h | lookback-bounded slice of the sorted view | not the floor |
| Disk-pressure eviction | **49 rounds / 10 min, measured** | oldest-first hour stream + `dropSegments` | **not priced — see §5** |
| `warmToday` (`addon/index.ts:2132`) | once, at boot | the LIVE HOUR only, 16 devices | one log line |
| Staging boot reconcile | once, at boot | measured: 62 dirs, 1 749 orphans, 8 353 ms, 99 pacing hops | bounded, done |

The segment watcher deserves its own line because it is a **latent** O(uptime)
churn source that today's instability hides. ffmpeg is spawned with
`-segment_list` and **no `-segment_list_size`**
(`packages/addon-pipeline/src/recorder/addon/ffmpeg-args.ts:110`), so the muxer
default applies and the playlist accumulates every segment for the writer's
whole life. `parseLivePlaylist` re-splits and re-objectifies all of it on every
2 s tick: cost ≈ `entries × ~120 B` per tick per writer. A writer running 5 h
at 10 s segments holds 1 800 entries ⇒ ~220 KB/tick ⇒ 110 KB/s ⇒ **3.3 MB/s
across 30 writers**. Today it does not bill that, because writers do not live
5 hours: **59 `SegmentWriter restarting` in one 16-minute window**, and ffmpeg
truncates the list on every spawn
(`packages/addon-pipeline/src/recorder/addon/staging-reconcile.ts:7`). Worth a
`-segment_list_size` on its own merits; not today's floor.

**Media in JS memory — there is none.** `external` 3–6 MB and `arrayBuffers`
0–2 MB in every steady-state sample, and `arrayBuffers=0MB→0MB` straight
through the forced compacting GC. The one per-segment media-derived structure
is `MfraTableStore`
(`packages/addon-pipeline/src/recorder/mfra-capture.ts:82`), TTL-bounded at
26 h (`mfra-capture.ts:59`): at 3.4/s a full fill is 318 k entries ≈ **80 MB**,
but it starts **empty** at boot and fills linearly over 26 hours — at boot+10
minutes it holds ~2 000 entries ≈ 0.5 MB. **A 26-hour ramp cannot produce a
5-minute plateau.** (It is nonetheless the largest structure in the recorder
whose bound is a TTL rather than the fleet, and it is worth remembering when
runner uptime stops being measured in tens of minutes.)

**Unbounded structures with uptime.** One found, and it was dead code as well
as a leak: **`EventMap` was write-only and never pruned** — `prune()` and
`events()` had no caller anywhere in `packages/addon-pipeline`, and every
qualifying motion event pushed an `EventMarker` carrying `metadata: { regions }`
that nothing ever read. **Resolved the same day: the module was deleted**, not
wired, because ADR-0194 had already considered and refused building the trigger
reconcile on those markers — "a leftover that describes the right design". The
paragraph below describes the structure as it stood when measured. The
provider's
raw region payload — and nothing ever reads it or drops it. Because it grows
with uptime and `heapUsed` shows no upward drift across a 2-hour process
lifetime, **it is not the plateau**; it is exactly the "leftover that describes
the right design" the working-style rules warn about, and it should be deleted
or wired to a pruner.

Everything else that can grow in the recorder is keyed by device or by
(device, profile) and bounded by the fleet.

---

## 4 · What is NOT explained, and the cheapest experiment that would name it

### The ranking

> **The ranking below is superseded by §11.1**, which re-prices items 2, 3 and
> 7 against measurements taken after this section was written. Two of them got
> smaller, so the unattributed share grew.

| # | Suspect | Bytes | Basis | Verdict |
| --- | --- | --- | --- | --- |
| 1 | **Unattributed retained set** | **~1.32–1.40 GB** | 1.44 GB post-compaction minus everything below | **the answer, not named** |
| 2 | `MfraTableStore` at full 26 h fill | ~80 MB | 318 k × ~250 B | 0.5 MB at boot+10; cannot plateau |
| 3 | `RecordingIndex` rows | 60–67 MB | 296 084 × 203–226 B, repo's own calibrations | 4% of the heap |
| 4 | Runner shell | ~50 MB | control: two idle `recorder` runners | framework floor |
| 5 | Boot ledger parse | 35–50 MB | 16 MB JSON + 296 k re-parsed strings | transient, GC'd |
| 6 | Write-path JSON churn | 37 KB/s (3.2 GB/day) | 3.4/s × ~11 KB | 0 retained |
| 7 | `DurableLedger` mirror, marginal | ~1.5 MB | strings shared with the index | two orders below §4's claim |
| 8 | `EventMap` | unbounded in uptime | one marker + `regions` per motion event | real leak, small today |

Items 2–8 sum to **115–125 MB resident at boot+10 minutes — under 9% of what
the process holds after a compacting GC.** Nothing in this pass, and nothing in
`recorder-index-at-scale` §7 or §4, accounts for the other ~1.35 GB.

### Say it plainly

**Only a read of V8's own accounting can name it.** But it does **not** have to
be a heap snapshot, and a snapshot should not be first — because the cheap
half of that read already exists in the codebase and is thrown away.

### The cheapest experiment: split the SIGUSR2 handler (≈5 lines, no snapshot)

> **DONE 2026-08-29, same day.** The split shipped; `oldSpace`,
> `largeObjectSpace` and `newSpace` are on the ordinary `[mem]` heartbeat.
> Neither branch below is what it found: it is **both at once** —
> `largeObjectSpace` 457–532 MB *and* `oldSpace` 779–918 MB, in a constant
> 1.75 ratio. §8 has the result and §11 the next two experiments.

`packages/system/src/kernel/moleculer/addon-runner.ts:758` computes
`v8.getHeapSpaceStatistics()` into a per-space breakdown and logs it — and then
`packages/system/src/kernel/moleculer/addon-runner.ts:768` writes a
`.heapsnapshot` **in the same handler**. One signal, both actions. So today
there is no way to get the free answer without also taking the expensive one
the operator has not authorised.

**Split them.** Emit the per-space breakdown on the ordinary `[mem]` heartbeat
(it is one `getHeapSpaceStatistics()` call per five minutes) and gate
`writeHeapSnapshot` behind an explicit flag. One heartbeat then halves the
search, continuously and for every runner:

- **`old_space` ≈ 1.4 GB, `large_object_space` small** ⇒ millions of small
  objects. The hunt becomes "what allocates ~7 M objects", and the first thing
  to check is whether the index really holds 296 k rows — the counters already
  exist and are already public (`RecordingIndex.sortedViewStats`,
  `recording-index.ts:170`; `RecordingIndex.hydrateReuseStats`,
  `recording-index.ts:175`), they are simply never logged.
- **`large_object_space` ≈ 1 GB+** ⇒ a handful of objects over V8's
  ~128 KB regular-object ceiling. The hunt becomes "who holds a huge array or
  string", which is a very short list in this addon.

**Second-cheapest, also no snapshot:** log the index's own size once a minute —
`byDevice` row count per device plus the length of each materialised sorted
view. If it reports ~296 k rows, §2's arithmetic is confirmed against the live
process rather than against a calibration, and item 3 of the ranking is closed
for good.

### If a snapshot is authorised, what it must show

Not "old_space is big" — that is what the free experiment already answers. It
must produce **the top 10 retainers by retained size, attributed to an owning
class field**, via the reverse-edge attribution that named
`RtspRestreamer.lastKeyframeRtpPackets` (1567 MB, 85%) in July — the procedure
is in (planning repo: sessions/sessions.md) and in the `homelab-hosts` skill's <!-- drift-ok: moved to the private planning repo -->
`references/camstack-ram-diagnosis.md`. Anything less will produce another
observation and no name. Two specific questions it must answer:

1. How many `SegmentRow` instances exist, and what is their total retained
   size? (Expected from §2: ~296 k and ~62 MB. If it is 6–7 M, the index is
   holding rows the ledger and the disk do not, and *that* is the bug.)
2. What is the single largest retained-size class, and which field of which
   long-lived object roots it?

---

## 5 · Two side findings, and one caveat on the plan

**The object-detection trigger's verdicts were mislabelled — it was firing.**

> **CORRECTED 2026-08-29, same day.** This section originally read "the
> object-detection recording trigger has never fired", inferred from
> `recorder: detection event did not qualify as a trigger` running at
> **3.3–3.9/s** with reason `malformed` in **394 of 394** sampled lines. The
> inference was wrong, and the way it was wrong is worth keeping.

`EventCategory.PipelineAnalyticsDetectionEvent` is one topic shared by **three**
emitters in `packages/addon-post-analysis/src/pipeline-analytics/index.ts` —
object (`index.ts:6900`, carrying `className`), motion (`index.ts:9309`) and
audio (`index.ts:8934`). Motion and audio carry no `className` because they
classify nothing. The category has no `EventPayloadMap` entry, so `event.data`
arrives `unknown`, and the only contract between the two sides was a private
interface in the consumer that declared the object variant alone and demanded
its `className` of every payload. So motion and audio traffic was labelled
`malformed` — the one reason that means *"the emitter drifted"* — and it
saturated the bucket.

Object payloads qualified throughout: in the same Loki window,
`recorder: trigger arrived late` carries `source: "object:person"` on device
104, and `{ kind: 'object' }` is constructed in exactly one place in the repo,
from this gate's own verdict.

**The lesson is the diagnostic one.** A 100 %-rejection reading looked like a
dead feature and was a saturated alarm bucket; a shared topic with no
`EventPayloadMap` entry let a consumer's private interface stand in for a
contract. The fix validates the envelope, discriminates on `kind`, and only
then demands the object fields; `malformed` now means an unreadable envelope,
and a total-rejection regime is reported per camera with `tags: { deviceId }`
instead of 3.3 lines/second that nobody reads.

**The write path is churning writers.** 59 `SegmentWriter restarting` and 59
`ffmpeg exited` in one 16-minute window, on top of **seven runner boots between
06:50 and 10:41Z**. Each restart truncates a playlist, orphans staged segments
(1 749 recovered at the 09:56 boot, 8.4 s) and re-writes ~10 s of duplicate
media that the lookback-bounded redundancy sweep will not revisit once the hour
ages out. Any memory arithmetic that assumes a stable writer — including the
segment-watcher playlist term in §3 — is measuring an installation that does
not currently exist.

**Caveat on `remove-the-memory-ceilings` §5a.** That row says the `heap-watch`
reclaim can be removed immediately because it is "pezza pura". That is right
about `hub/pipeline-analytics`, which reclaims every 120 s and has printed the
`STEADY STATE, not a rescue` warning four times today. It is **not** right about
the recorder, which reclaimed **once in six hours** — and that single pass is
the instrument that produced §1.2, the only direct measurement of this
process's live set anyone has. Removing it before the retainer is named
destroys the cheapest probe currently in production. §5a should name which
process it is talking about.

---

## 6 · What would falsify this

- **The index turns out to hold millions of rows.** Then §2's arithmetic is
  right about cost-per-row and wrong about row count, the retainer *is* the
  index, and stage 3's residency bound is the fix after all. The one-minute
  index-size log settles it without a snapshot.
- **A `[mem]` sample lands below ~600 MB in steady state.** One such sample
  falsifies §1.1 and reopens (b). Sixty consecutive samples did not.
- **`large_object_space` turns out to hold most of the 1.4 GB.** Then the
  retainer is a small number of huge objects and none of the per-row arithmetic
  in this document is relevant to finding it.
- **`loopMax` 2.5–2.9 s is not GC.** The forced last-resort compacting pass
  took 1 005 ms; the recurring stall is 2.5–2.9 s, i.e. *longer* than a full
  compaction. Either mark-compact under allocation pressure is slower than a
  last-resort pass, or part of that stall is something synchronous nobody has
  identified. Not settled here, and it is the same open item as
  `remove-the-memory-ceilings` §7.

  > **ANSWERED 2026-08-29 15:40Z — see §10.** The stall tracks this process's
  > own `heapUsed` from a cold boot (0 → 242 → 898 → 2 627 ms while the heap
  > goes 115 → 276 → 762 → 1 403 MB) and plateaus with it. It is heap-driven,
  > i.e. GC. It is the same finding as the memory, not a second one.
  >
  > **RE-OPENED the same evening — §10's answer is falsified by the §11.3
  > instrument**: `cause: "synchronous-block"`, `gcMs` ≤ 413 ms inside every
  > 2 s+ stall. Heap-driven, yes; GC, no. See §10's correction block.

---

## 7 · 2026-08-29, second pass (15:00–15:40Z) — per-space telemetry, and what it kills

Method: the same read-only tools (`hl loki-query`, `scripts/hub/hub.mjs`), plus
`ls`/`find`/`wc -c` inside the `CamStack` container over SSH. No snapshot, no
SQLite, no hub mutation.

Three of this document's own suspects are now excluded by **measurement rather
than by arithmetic**, and the two per-space numbers the §4 experiment asked for
now exist on the heartbeat. What did **not** happen is the naming of the
retainer; §8.4, §9 and §11.5 state that gap as precisely as it can be stated
without a snapshot.

### 7.1 The census closed item 3 of §4's ranking — the index is 140× smaller than §2 estimated

`RecordingIndex.sortedViewCensus`
(`packages/addon-pipeline/src/recorder/recording-index.ts:216`) is now on the
5-minute sweep (`packages/addon-pipeline/src/recorder/addon/index.ts:1737`).
Twelve consecutive censuses on pid 1733948, 14:16→15:22Z:

| | first | last |
| --- | --- | --- |
| `rowSlots` | 0 | 4 515 |
| `sortedViews` | 0 | 14 |
| `largestViewRows` | 0 | 777 |
| `rowsAllocated` (lifetime) | 0 | **2 032** |
| `ledgerHours` | 1 540 | 1 549 |

`rowsAllocated` is a **lifetime** counter and it reads 2 032 after 66 minutes
and ~13 000 finalizes. §2 priced the index at 60–67 MB on the assumption it
held all 296 084 archive rows; since D287 removed the boot walk it holds
**2 032**, i.e. **~0.44 MB**. The index is not 4 % of the heap, it is **0.03 %**.
§2's per-row calibration is still correct; the row COUNT it multiplied is
obsolete. Falsifier 1 of §6 ("the index turns out to hold millions of rows") is
**dead**: it holds thousands.

### 7.2 The playlist tier is measured, not assumed — 607 bytes

§3 flagged `-segment_list_size` as a latent O(uptime) churn source. It shipped
(`packages/addon-pipeline/src/recorder/addon/ffmpeg-args.ts:129`, bound computed
by `packages/addon-pipeline/src/recorder/addon/segment-watcher.ts:135`). Read
from the live staging tree at 15:35Z:

```
31 live.m3u8 under /recordings/.rec-tmp   largest 607 B   median ~600 B
```

Total playlist text resident anywhere in the process: **18.8 KB**. Re-read every
2 s per writer (`packages/addon-pipeline/src/recorder/addon/segment-watcher.ts:436`)
⇒ **9.4 KB/s** of transient string, against §3's projected 3.3 MB/s. The new
build is confirmed live independently of the file sizes: `segment playlist
rolled past entries this watcher had not handled` — a line that exists only in
the bounded build — fired 8 times in 30 minutes. **Excluded, with production
evidence.** A 607 B string is 216× below V8's large-object threshold and can
never enter `large_object_space`.

### 7.3 `MfraTableStore`, re-priced against the large-object threshold

The §4 ranking's item 2 asked to be re-priced against 256 KB. V8's actual
ceiling is `kMaxRegularHeapObjectSize` = **131 072 B**; anything at or above it
is allocated directly in `large_object_space` and never scavenged.

- One `SeededMfraTable` is `{trackId, mfraOffset, samples[2–4]}` ≈ **200 B**
  (`packages/addon-pipeline/src/recorder/mfra-capture.ts:83` stores it beside a
  `startMs`). **Three orders of magnitude** below the threshold. No mfra table
  is, or can become, a large object.
- The only object in the store that can ever reach `large_object_space` is the
  `Map`'s own backing store. An `OrderedHashMap` needs ~3.5 slots per entry at
  4 B each, so it crosses 131 072 B at **~9 400 entries** — 46 minutes at
  3.4/s — and at the full 26 h fill (`mfra-capture.ts:59`, 318 k entries) it is
  **one object of ~4.5 MB**. That is **0.9 %** of the 490 MB space.
- The store's TOTAL at the uptimes observed: 3 060 entries ≈ **0.77 MB** at
  boot+15 min, 12 240 ≈ **3.1 MB** at boot+60 min.

**Convicted of nothing.** It remains the largest TTL-bounded structure in the
addon and it remains irrelevant to this heap.

### 7.4 The `DurableLedger` mirror at runtime — the mechanism exists, the magnitude does not

The open question was whether anything makes hours paths-resident *while the
process runs*, now that boot does not. It does, and the path is
`StorageEvictableProvider.evict`
(`packages/addon-pipeline/src/recorder/storage-evictable-provider.ts:129`) →
`SegmentHourLedger.oldestSegments`
(`packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:925`), whose
phase two calls `this.ledger.stage(hour)`
(`packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:971`).

Measured cadence: `recorder: eviction round complete` = **214 lines / 30 min =
7.13 rounds/min**. Each round stages a full page of `OLDEST_HOUR_PAGE = 32`
hours ⇒ **228 hours/min** ⇒ the whole 1 549-hour ledger is paths-resident in
**6.8 minutes**. That is a real ramp-to-plateau with roughly the observed time
constant, so it deserved pricing rather than dismissal.

Its ceiling, for the WHOLE archive:

| Term | Arithmetic | Bytes |
| --- | --- | --- |
| Path strings | 296 084 × ~72 B | 21.3 MB |
| `paths` FixedArray slots | 296 084 × 4 B, spread over 1 549 arrays | 1.18 MB |
| Hour rows + `Map` entries + keys | 1 549 × ~190 B | 0.3 MB |
| **Ceiling** | | **~23 MB** |

**1.8 % of the heap, and 0 % of `large_object_space`**: the largest `paths`
array a real hour can hold is 360 slots = 1 440 B, **91× below** the large-object
threshold. Even a 1 708-segment restart-storm hour is 6.8 KB. Nothing on this
path can allocate a large object. **Excluded.**

### 7.5 The still / scrub tier and the export engine

- `StillFrameService` (`packages/addon-pipeline/src/recorder/still/still-frame-service.ts`)
  holds **no cache by construction** — one ffmpeg one-shot per request, ≤3
  concurrent, ≤8 queued, JPEG returned and dropped. The sprite-sheet
  scrub-thumbnail tier it replaced is retired (`recorder: removed legacy
  scrub-thumbnail dir`, once at boot).
- Data-plane traffic is measured and negligible: `recorder still data-plane
  served` = 1 and `recorder playback data-plane served` = 1 per 30 min.
- Export: 80 rows, queue is `string[]` of ids, one live `stderrTail` bounded by
  `STDERR_TAIL_LINES`. `base64` appears exactly three times in the recorder
  (`addon/recording-export-provider.ts:282`, `addon/footage-render.ts:127`,
  `addon/footage-render.ts:168`) and all three are request-driven.

**Excluded.** And it is worth stating why in one line, because it is the
cheapest exclusion in the document: `external` is **3–9 MB** and `arrayBuffers`
**0–6 MB** in every one of 143 samples over 12 hours. **There is no media in
this process's memory, in any form that uses a backing store.**

---

## 8 · What the per-space heartbeat actually shows

§4's cheapest experiment shipped: `oldSpace` / `largeObjectSpace` (and
`newSpace`) are now on the ordinary `[mem]` line, split from the snapshot.
143 samples, 12 hours, 14 process lifetimes.

### 8.1 The growth curve of one boot, per space

pid 1733948, booted 14:16Z, 31 writers up by 14:17 (18 `recorder: writer
spawned` in that minute):

| t | `heapUsed` | `oldSpace` | `largeObjectSpace` | `loopMax` |
| --- | --- | --- | --- | --- |
| +0 | 115 | 88 | 8 | 0 ms |
| +5 min | 276 | 163 | 65 | 242 ms |
| +10 min | 762 | 476 | 257 | 898 ms |
| +15 min | 1 403 | 877 | 506 | 2 627 ms |
| +20…+66 min | 1 252–1 447 | 779–918 | **457–523** | 2 471–3 128 ms |

The previous boot (pid 229, 13:19Z) reproduces it — 823 MB at +5, 1 424 at +10 —
and then keeps drifting: 1 851 MB / `oldSpace` 1 209 / `largeObjectSpace` 604 by
+56 min. So the shape is **a 15-minute ramp to a floor, plus a slow drift**, not
a hard bound.

### 8.2 Two spaces, one allocation stream

`oldSpace : largeObjectSpace` across every sample of both boots is
**1.64–2.01, mean 1.75**, from the third sample onward. Two independent
retainers do not hold a constant ratio for an hour across two process lifetimes.
Whatever fills this heap fills both spaces from **one** stream, ~36 % of its
bytes in objects ≥ 131 072 B.

### 8.3 The floor is real, and §1.1's argument is now stronger than when it was made

The 15-minute ramp gives the refill period directly: **1 288 MB / 900 s =
1.43 MB/s net**. If the live set were small and this were a sawtooth against
V8's allocation limit, the cycle would be ~15 minutes and a 5-minute sampler
would land in the lower half of it constantly. Twelve consecutive samples of one
pid have a **minimum of 1 252 MB** and a peak-to-trough of **±8 %**. A sawtooth
whose trough is a few hundred MB cannot produce that series.

`largeObjectSpace` says the same thing on its own: **floor 457 MB**, never once
lower, across 14 samples and two boots. Large objects are allocated **directly**
in that space and are freed only by a major GC — so 457 MB is a quantity that
survives major GCs. **The retained set is confirmed, independently of §1.2's
40-second gap, and it is now split: ~450 MB of it is in objects ≥ 128 KB.**

### 8.4 The count bound that makes the mystery sharp

457 MB ÷ 131 072 B = **at most 3 657 objects**, formed over 900 s ⇒ **≤ 4.1
large objects per second**, retained.

And here is the finding that matters most in this section: **there is no
allocation site anywhere under the recorder's source tree that produces a
≥ 128 KB object in steady state.** Every long-lived container is bounded by the
fleet (≤ 31 writers), by an hour (≤ 360 paths = 1.4 KB), by a page (32 rows), or
by a window; every string it handles is a playlist (607 B, measured) or an
hour's `paths` JSON (≤ 20 KB). The one exception is the `MfraTableStore` Map's
backing array — one object, 4.5 MB at full fill (§7.3). **~450 MB of large
objects are being held by code that, as read, cannot allocate one.**

---

## 9 · The allocation budget does not balance either

Every steady-state path, priced at its MEASURED rate:

| Path | Rate | Heap bytes/s | Retained? |
| --- | --- | --- | --- |
| Eviction `oldestSegments` (§9.1) | 7.13 rounds/min | **~270 KB/s** | no (≤23 MB, §7.4) |
| Finalize: stat + move + row + `JSON.stringify(paths)` + msgpack | 3.4/s | ~100 KB/s | no |
| Config reads (`get recorder:recording-configs`) | ~12/s | ~12 KB/s | no |
| Log emission | 5.8 lines/s (measured) | ~6 KB/s | no |
| Playlist re-read + parse | 31 × 607 B / 2 s | 9.4 KB/s | no |
| mfra capture (2 `Uint8Array` reads → external) | 3.4/s | ~1 KB/s heap | ≤3 MB |
| Placement tick (`statfs` + `accountingByProfile`) | 2/min | negligible | no |
| **Sum** | | **≈ 0.40 MB/s** | |

Against the **1.43 MB/s** the boot ramp requires. **The priced paths are 3.6×
short, and all of them are transient.** This is stated as a result, not as a
caveat: the dominant allocator of this process is not among the things this
document, `recorder-index-at-scale` or `remove-the-memory-ceilings` have
examined.

### 9.1 The largest allocator that WAS found — and it exists to pick two rows

`SegmentHourLedger.oldestSegments`
(`packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:925`) has a
two-phase design whose phase one is documented as "walks oldest-first until the
accumulated bytes cover the target". It does not. The inner loop pushes **every
record of the page** into `chosen` with no `break` on `covered >= targetBytes`,
so a page of `OLDEST_HOUR_PAGE = 32` hours is always selected — and one hour of
one camera-profile is hundreds of megabytes, so a page is always enough and
always all of it.

Phase two then reads those 32 rows **with `paths`**, `JSON.parse`s each blob
(~14 KB at ~195 paths), and constructs one `SegmentRow` per path
(`segment-hour-ledger.ts:975`):

```
32 hours x ~195 paths          = 6 240 SegmentRow per round
6 240 x 7.13 rounds/min        = 44 500 rows/min = 742 objects/s
742/s x 203-226 B              = 151-168 KB/s
+ 44 500 fresh path strings/min (~52 KB/s)
+ 32 x 14 KB JSON per round     (~53 KB/s)
+ one 6 240-slot `toSorted` copy per round
                               ≈ 270 KB/s
```

What the round then does with those 6 240 rows, measured over 214 rounds:
`{"rows":2,"buckets":2,"removed":2,"reclaimed":313956}`. **Six thousand row
objects built to delete two segments.** Rounds also run 570–15 436 ms.

This is not the retainer — nothing here survives the round except the ≤23 MB
staging of §7.4 — but it is the largest allocation source in the addon, it is
two thirds of everything this pass could price, and the fix is a `break` in the
inner loop plus a phase-two fetch of only the hours actually needed.

---

## 10 · `loopMax` 2.4–3.1 s is the heap. Same finding, not a second one

> **FALSIFIED 2026-08-29, same evening — by the instrument §11.3 itself
> wired.** The GC attribution now runs on the recorder, and every stall line it
> has produced reads `cause: "synchronous-block"`: `stallMs` 2 007–2 623 ms
> with total `gcMs` 35–413 ms and `longestGcMs` 1–35 ms, across three process
> lifetimes. The correlation below is real — the stall does scale with the
> heap — but the attribution "it is GC" is wrong: something **synchronous**
> that touches a heap-sized structure blocks the loop for ~2 s, 1–3 times a
> minute. §6's fourth falsifier resolved to its OTHER branch ("part of that
> stall is something synchronous nobody has identified"). This section was a
> same-day correction that closed the question in the wrong direction; do not
> quote it. See
> `plans/2026-08-29-memory-cpu-checkpoint.md` (F4, O2).

§6's fourth falsifier is resolved. Within pid 1733948, from a cold boot, the
stall and the heap move together and plateau together:

| `heapUsed` | 115 | 276 | 762 | 1 403 | 1 252–1 447 |
| --- | --- | --- | --- | --- | --- |
| `loopMax` | 0 ms | 242 ms | 898 ms | 2 627 ms | 2 471–3 128 ms |
| ms per MB | — | 0.88 | 1.18 | 1.87 | 1.9–2.4 |

Nothing in the recorder's periodic work changed across those 15 minutes — all
31 writers were spawned in the first minute, the placement tick, the eviction
rounds and the export sweep ran from boot at their final cadence. The only
quantity that moved is the heap, and the stall moved with it, superlinearly, and
then stopped when the heap stopped. **The stall is a function of this process's
own heap: it is GC.** Fixing §8 fixes §10; there is no second bug to hunt.

**A near-miss worth recording so nobody re-walks it.** `recorder: placement pass
ran long — phase breakdown` reports `recomputeMs` of 2 421 / 2 803 / 3 086 ms,
which matches `loopMax` almost exactly and looks like the answer. It is not:
that field is an AWAITED duration (the same lines carry `enumerateMs` up to
5 001 ms, and the phase is `statfs` on a contended array plus one store round
trip), and the boot series above shows `loopMax` at 242 ms while the placement
tick was already running its final workload.

**Investigator artifact, disclosed.** The 15:22Z sample reads
`loopMax=99301ms`. At 15:19–15:21Z this session ran a `find` over `/data` and
`/recordings` inside the `CamStack` container, which is the most likely cause.
Treat that one sample as contaminated; every other number in §8 and §10 predates
any command issued here.

---

## 11 · Ranked, with honest confidence — and the two cheapest experiments

### 11.1 The ranking, as of 2026-08-29 15:40Z

| # | Candidate | Bytes | Confidence | Verdict |
| --- | --- | --- | --- | --- |
| 1 | **Unattributed retained set** | **~1.20–1.25 GB** (≈450 MB in `large_object_space`, ≈780 MB in `old_space`) | high that it exists; **zero** on what it is | **still not named** |
| 2 | `DurableLedger` mirror, fully paths-resident | ≤23 MB, reached in 6.8 min | high | right shape, 2 orders too small |
| 3 | `MfraTableStore` | 0.8 MB at +15 min, 3.1 MB at +1 h, 80 MB at 26 h | high | excluded |
| 4 | Runner shell | ~50 MB | high (control: idle recorder 52 MB) | framework floor |
| 5 | `RecordingIndex` rows | **0.44 MB** (2 032 rows, measured) | high | supersedes §2's 60–67 MB |
| 6 | Eviction `oldestSegments` churn | 270 KB/s, 0 retained | medium-high | largest allocator found; fix it anyway |
| 7 | Playlist tier | 18.8 KB total (measured) | high | excluded |
| 8 | Still / scrub / export | 0 resident | high | excluded |

Items 2–8 sum to **~75–80 MB**. §4 could account for 9 % of the heap; this pass
accounts for **~6 %**, because two of §4's own items got smaller when they were
measured. **The pass made the answer more certain and the unexplained fraction
larger.** That is the honest summary.

### 11.2 Experiment A — one string concatenation, settles retained-vs-sawtooth at t+0

> **DONE 2026-08-29, same day.** The reclaim line now ends with
> `heapUsed=<before>MB→<after>MB`
> (`packages/system/src/kernel/heap-watch.ts:1061`), **appended after `took=`**
> so every field this line already carried keeps its name and its position — the
> Loki queries written today match on that prefix. `after` is the read taken
> immediately after the compacting pass, so the second number is the live set at
> t+0 on every runner, forever. The 40-second gap this section is about is
> closed for the next reclaim; the recorder reclaims about once in six hours, so
> the first reading lands within a working day without touching the cadence.

`packages/system/src/kernel/heap-watch.ts:1026` already reads the full
`memoryUsage()` **immediately** after the compacting pass, into `after`, and
`sample` is the reading from immediately before it. The log line at
`packages/system/src/kernel/heap-watch.ts:1028` prints `rss` from both and
`arrayBuffers` from both — and **drops `heapUsedMb` from both**. Add it:

```
heapUsed=${sample.heapUsedMb}MB→${after.heapUsedMb}MB
```

§1.2 — the only direct measurement of this process's live set anyone has — had
to use a heartbeat **40 seconds** after the pass, and every reader since has had
to argue about what happened in those 40 seconds. This makes it t+0, for every
runner, forever, at the cost of one string concatenation and zero new
measurement. The recorder reclaims about once in six hours, so the answer lands
within a working day without touching the cadence.

### 11.3 Experiment B — the GC attribution already exists, in this package, wired to one addon

> **DONE 2026-08-29, same day, and REUSED rather than promoted.** The recorder
> now arms the existing monitor as the first statement of its `onInitialize`
> (`packages/addon-pipeline/src/recorder/addon/index.ts:485`) and stops it in
> `onShutdown` (`packages/addon-pipeline/src/recorder/addon/index.ts:1229`).
> Above the recording-node gate on purpose: an inert recorder that stalls is
> itself a finding, and the cost on a silent process is one unref'd 1 s timer.
>
> **Promotion into `@camstack/system` was considered and rejected.** It would
> either duplicate a mechanism that already exists — forbidden — or relocate the
> module across a package boundary, which is a refactor with a slower ship chain
> (publish train rather than `camstack deploy`) on a day whose constraint is
> measurement only. The module already ships in the same bundle as the recorder,
> so the reuse costs one import and one call and nothing else. `loopMax=2660ms`
> becomes a line carrying `cause`, `gcMs`, `gcCount`, `longestGcMs` and
> `heapUsedMb`, which turns §10's correlation into an attribution.

`startEventLoopStallMonitor`
(`packages/system/src/kernel/event-loop-stall-monitor.ts:105`)
runs a `PerformanceObserver({entryTypes:['gc']})`, attributes an observed stall
to GC or not-GC, and logs `stallMs`, `cause`, `gcMs`, `gcCount`, `longestGcMs`
and `heapUsedMb`. It ships inside `@camstack/addon-pipeline` — the **same
bundle** as the recorder — and has exactly one caller,
`packages/addon-pipeline/src/detection-pipeline/index.ts:801`.

One import and one call in the recorder's start turns §10's correlation into an
attribution, and turns `loopMax=2660ms` into a line that says which GC and how
long. No new module, no new dependency, no snapshot.

### 11.4 If a snapshot is authorised, what it must show

§4's two questions stand, with one added and one rewritten by §7.1:

1. **Enumerate `large_object_space`.** Count and total retained size of live
   objects ≥ 131 072 B, grouped by V8 type (FixedArray / string / JSObject) and
   attributed to an owning class field. §8.4 predicts **≤ 3 657 objects** and
   the source predicts **none**. Whichever is wrong, that is the bug.
2. **The single largest retained-size class, and which field of which long-lived
   object roots it** — the reverse-edge attribution that named
   `RtspRestreamer.lastKeyframeRtpPackets` in July.
3. **Live `SegmentRow` count.** §7.1's census says **2 032**. If the snapshot
   says millions, the counter is lying and *that* is the finding.

### 11.5 What this pass could NOT determine

Stated plainly, because four inferences were closed too early on 2026-08-29 and
three of them were wrong:

- **What holds ~450 MB in `large_object_space`.** Not narrowed at all. The
  count bound (§8.4) and the source audit are in direct contradiction and the
  contradiction is unresolved. The next pass should start **outside**
  the recorder's own source tree — the runner shell, `kernel/transport`, the msgpack codec,
  the tRPC/zod layer — because the addon has been read and does not contain a
  large-object allocation site.
- **What holds ~780 MB in `old_space`.** Not narrowed. The 1.75 ratio (§8.2)
  says it is the same producer, so it is one hunt, not two.
- **Why the ramp stops at ~15 minutes on one boot (pid 1733948) and keeps
  drifting on another (pid 229, to 1 851 MB at +56 min).** Two different
  behaviours from the same build under the same fleet. Not explained.
- **Whether §1.2's "1.44 GB live" is exact.** §8.3 independently confirms a live
  set of that order from the sampling distribution, but the 40-second gap in the
  original measurement is still there and Experiment A is what closes it.
- **The 2 000 ms difference between the reclaim's own 1 005 ms compaction and
  the recurring 2.4–3.1 s stall.** §10 shows the stall is heap-driven; it does
  not show why a mark-compact under allocation pressure is 2.5× a last-resort
  pass. Experiment B answers it.
- **Nothing about the agent-side recorders was re-checked.** The 52 MB control
  is quoted from §1.3 and was not re-measured today.

## 2026-09-28 — still unnamed; instrumentation added

The retainer is still not named. What is now known: every lifetime builds
~2.3 GB (~910 MB of it large-object space) in ONE silent, CPU-bound phase
starting 3–5 min after boot, right after the first hour-adoption pass, and the
large-object floor doubled at one boot (2026-09-03 06:56Z, 458 → 914 MB) — the
first boot to show a second recording location. See (planning repo: sessions/sessions.md) <!-- drift-ok: moved to the private planning repo -->
(2026-09-28).

Two cheap instruments, no snapshot:

- `heap-delta.ts` — every periodic pass, every boot phase and every inbound
  cap method logs `recorder: unit of work moved the heap` when it grew
  `heapUsed` or large-object space by ≥ 50 MB, or ran ≥ 5 s, with
  before/after/delta and `inFlight` (the maximum other measured units open at
  once during it). The delta is a wall-window measurement, and `heapUsed`
  includes garbage not collected yet: a line can name an allocator rather than
  a retainer. Repetition while the heap floor rises is the stronger signal.
- The 5-minute `recorder: index census` line now also carries the entry counts
  of every other long-lived container (calendar, mfra with an estimated byte
  total, hour ledger maps, placement, exports, controller). If they sum to a
  small fraction of the heap, the retainer is outside the recorder's own
  fields — itself the answer.

## 2026-09-29 — named: the calendar's exact rung ([D674](../decisions/adr-0674-a-whole-archive-fact-is-read-from-the-ledger-and-a-calendar-walk-is-clamped-to-it-and-bounded.md))

The census named it. `calendar.hourKeys = 11,937,796 = 24 × 497,408`, which is
every (camera, served profile) pair × every hour since 1970-01-01.

- **The asker.** `pipeline-analytics` computed its follow-recordings floor as
  `getAvailability({ fromMs: 0, toMs: now })` per camera, every 10 min, from
  both runners.
- **What the calendar did.** It walked that window and cached every hour, empty
  ones included, under string keys, in two unbounded Maps.
- **The cost.** ~2.2 GB of heap, plus ~940 MB of LOS for the two 2^24-capacity
  hash tables. That is the "silent build phase" (sequential cold calls of ~12 s
  each) and the 2026-09-03 LOS doubling (both Maps crossing 2^23).

The fix has three parts:
- the floor now comes from the ledger (`recordingArchive.getStorageUsage`);
- walks are clamped to the ledger floor and refused above 8,784 hours;
- the rung is numeric and bounded under the index's own budget.

The census now carries `approxBytes`, `emptyHours`, `segsReadAtKeys` and
`evictedHours` for the calendar.

Expected after deploy (an estimate, not yet measured):
- `hourKeys` in the hundreds to low thousands;
- calendar `approxBytes` of a few MB;
- LOS well under the 913 MB floor;
- heapUsed ~0.3–0.5 GB.

