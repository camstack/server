---
title: The recorder index at 30 TB — what must be resident, what must be a query
last-verified: 2026-08-30
covers:
  - packages/addon-pipeline/src/recorder/recording-index.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/addon/recording-provider.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/segment-store.ts
  - packages/addon-pipeline/src/durable/durable-ledger.ts
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
  - packages/addon-pipeline/src/recorder/evict-select.ts
---

# The recorder index at 30 TB

> **The operator's question.** *"Cosa accade quando collegherò il mio array da
> 30 TB? Questo indice sarà insostenibile. Non credo sia una cosa necessaria,
> soprattutto a questa granularità."* [What happens when I connect my 30 TB array? This index will be unsustainable. I do not think it is necessary, especially at this granularity.]
>
> **Answer, up front.** The operator is right that the recorder does not
> survive the upgrade, and right that whole-archive per-segment residency is
> unnecessary — but the mechanism is not the one the arithmetic in the question
> assumed. Today's heap is **not** dominated by segment rows (there are ~294 k
> of them, not ~7 M — §1), and the binding ceiling is the runner's **3.26 GB V8
> heap limit**, not the container's 32 GiB. At 30 TB the row population grows
> 27–360× depending on bitrate mix (§2), and either scenario kills the runner —
> first at boot (a single ~0.5–6 GB ledger query), then in steady state. The
> fix is a granularity split the codebase is already half-way through
> (ADR-0255, the tri-state hydration): **hour summaries always resident,
> segment detail resident only for viewed windows and evicted, every
> archive-wide question a SQL statement** (§5). Three CPU defects are
> independent of all of that and fixable this week (§7).

Method note: all live numbers below were read from the hub on 2026-08-29
(read-only tRPC + Loki; no production SQLite opened). Where a number is a
projection, its assumptions are named inline.

---

## 1 · What is actually on the hub today — and where the premise breaks

### The archive, from the durable hour ledger (one `aggregate`, one row query)

| Fact | Value | Source |
| --- | --- | --- |
| Hour rows (`recorder:segment-hours`) | **1 507** | `settingsStore.aggregate`, count |
| Segment rows | **294 284** | sum of `segments` |
| Footage bytes | **1.089 TB** | sum of `bytes` |
| Segment length | **10 s** (unchanged) | row min/max spans ÷ counts |
| Active writers (device·profile, last 24 h) | **30** (16 devices; 8 cameras continuous high+low) | per-writer ledger census |
| Rows/day | **~129 k** | last-24 h sum (129 556) |
| Bytes/day | **~462 GB** | last-24 h sum (462 GB) |
| Mean segment size | high **7.2 MB** (~5.8 Mbps), low **455 KB** | per-profile aggregates |
| Effective retention on live locations | **~2.3 days** (oldest hour 08-27 02:00) | per-location ledger census |
| Why 2.3 days | `maxUsedGb: 1000` on `recordings:default`; disk-pressure eviction is nibbling continuously right now (ops log: `reason: 'quota'` prunes every few seconds) | `storage.listLocations`, `recording.listOpsLog` |
| In-RAM index ≈ ledger | `getStorageUsage` per-device totals (from `RecordingIndex.accounting`) sum to 1 088 844 685 051 B vs the ledger's 1 088 899 329 581 B | both read 2026-08-29 |

### The process

From the runner's own `[mem]` telemetry (Loki, addon-runner scope, `nodeId:
hub/recorder`) and `metricsProvider.listNodeProcesses`:

- RSS **2.1–2.5 GB**, `heapUsed` **1.4–1.8 GB**, `heapTotal` up to 2.33 GB,
  **`heapLimit` 3 264 MB** (`--max-old-space-size=3072` on the runner command
  line), `rssBudget` 3 103 MB. `external`/`arrayBuffers` are 2–9 MB — this is
  pure JS heap, not buffers.
- **GC is 48.7 % of the recorder's CPU** (65 % total).
- **`loopMax` 2.1–2.8 s appears in every 5-minute sample in steady state**,
  not only at boot. The first post-boot sample today read `loopMax` 353 ms;
  the 2 s+ stalls begin once the heap is hot.
- The restart storm is real and measured: **7 recorder boots between 08:50 and
  10:42** today (`segment-hour ledger loaded` × 7, hours 1 376→1 497), each
  re-running the synchronous hydrate and re-building the heap. Five minutes
  after the 10:42 boot, `heapUsed` was already 1 384 MB (from 118 MB).

### Where the premise breaks — stated plainly

The question (and D255's context paragraph, dated 08-27) sized the index at
**~7.0–7.5 M `SegmentRow`s**. That was true of the 08-27 archive shape —
13 cameras × 2 profiles × ~30 days of low-bitrate segments, ~282 KB average
(2 TB ÷ 7.1 M). It is **not true today**: the fleet now records `high` at
~5.8 Mbps, the 1 TB quota compressed retention to ~2.3 days, and the archive
is **294 k rows**. At the calibrated all-in cost of ~226 B/row (D255: 1 606 MB
÷ 7.1 M rows — row object + path string + map entry + views), today's rows
account for **~66 MB** of heap.

So today's 1.4–1.8 GB `heapUsed` is **not the segment rows**. With
external ≈ 0 and rows ≈ 66 MB, the heap is dominated by *allocation churn and
whatever V8 has not yet collected* — consistent with GC at 48.7 % of CPU, with
the heap refilling to 1.4 GB within 5 minutes of a cold boot, and with the
recurring 2 s+ `loopMax` (most plausibly major-GC mark-compact over a 2.3 GB
`heapTotal`; a 294 k-row scan cannot block for 2 s). The churn sources are
identifiable in code and are §7's subject. What retains the remainder could
not be proven without a heap snapshot (not taken against production — §10).

**This does not rescue the recorder at 30 TB.** It changes *which* wall it
hits first, and it means the design must fix two independent things: the
residency scaling law (§2) *and* the churn (§7). A design that only bounded
residency would ship into a process that already spends half its CPU on GC at
0.3 M rows.

### Side finding: ghost location rows

2 131 segments / 15.1 GB sit on locationId `recordings:high` (hours 08-15 →
08-17), a location id that no longer resolves (`storage.listLocations` knows
only `recordings:default` + `recordingsLow:default`). Those rows are invisible
to the eviction domain (built from *current* location ids,
`packages/addon-pipeline/src/recorder/addon/eviction-domain.ts`), unaddressable
by playback (`collectRangeSegments` drops rows whose location is unknown,
`packages/addon-pipeline/src/recorder/addon/recording-provider.ts:404`), and
they inflate `oldestMs` in `getStorageUsage` (devices report "oldest 08-15"
while the evictable stream starts 08-27). They are also why the hour count in
the last-24 h census exceeds 24 for some writers. Until they are cleaned, any
retention arithmetic that trusts `oldestMs` is lied to.

**Resolved by D296 (2026-08-30), and the interesting part is what it had to
resolve first.** D148 says the ledger forgets an hour only on a trusted walk or
an eviction — and an unresolvable location has no root to walk, so under D148 as
written these rows could never be forgotten by anything. The reconcile
(`packages/addon-pipeline/src/recorder/addon/ghost-location-sweep.ts`) resolves
that explicitly rather than stepping around it: a row's paths are relative, so
it resolves EVERY path against EVERY currently-resolvable physical root, and
that per-path `storage.exists` sweep is the same confirmation a walk gives.
One path found makes the row **mis-pointed** and it is repointed, never deleted;
every path absent everywhere makes it orphaned and it is forgotten. It runs
daily, bounded to 16 hour rows and 4 000 probes per pass, and refuses on any
probe error. It is not a one-off: it is also the net under a `force` delete
past D293's occupancy check.

A second side finding: the restart storm wrote overlap duplicates — one hour
row (`592|high`, 10:00 UTC today) holds **1 708 segments** where a continuous
hour holds ≤ 360. The redundancy sweep
(`packages/addon-pipeline/src/recorder/redundant-segments.ts`) is
lookback-bounded and will not revisit storm hours once they age past its
window; those hours stay fat until evicted.

---

## 2 · The 30 TB projection — the real number, with its assumptions

**The scaling law.** Index heap scales with **segment count**, not bytes:
`rows = writers × retention-days × 8 640` (10 s segments). Retention-days at a
fixed write rate scales with capacity. Bytes/row on disk is a bitrate choice;
bytes/row in heap is constant (~226 B all-in).

Assume the operator gives recordings ~28 TB of the 30 (and lifts or raises
`maxUsedGb` — attaching 30 TB and keeping a 1 TB quota changes nothing).

**Scenario A — today's fleet and bitrate mix** (~30 writers, ~462 GB/day,
~129 k rows/day):

- retention ≈ 28 000 GB ÷ 462 GB/day ≈ **60 days**
- rows ≈ 129 k × 60 ≈ **7.8 M** (call it 8 M with fleet growth)
- index heap ≈ 8 M × 226 B ≈ **1.8 GB**, plus materialised sorted views
  (two pointer arrays per device·profile,
  `packages/addon-pipeline/src/recorder/recording-index.ts:86`) ≈ +130 MB,
  plus the `DurableLedger` mirror (~43 k hour rows whose `paths` arrays point
  at ~8 M strings shared with the index at boot, plus per-hour row objects) ≈
  +100–200 MB → **~2.1–2.3 GB retained**
- against `heapLimit` 3 264 MB, **on top of a churn regime that already floats
  `heapUsed` at 1.4–1.8 GB with a ~66 MB retained archive**. Retained + churn
  exceeds the limit: the runner dies by V8 heap-limit abort or a GC death
  spiral. **Scenario A does not survive.**

**Scenario B — the operator's implicit arithmetic** (the 08-27 bitrate mix,
~282 KB average segment, i.e. the fleet re-tuned toward low-bitrate continuous
recording): 28 TB ÷ 282 KB ≈ **~100 M rows** ≈ **~22 GB** of heap. This is
the "108 M rows / ~25 GB" in the question, and it is the correct projection
*for that mix*. It exceeds not just the runner heap limit but any budget the
hub node could grant one addon. **Scenario B does not survive by an order of
magnitude.**

**Boot dies first, in both scenarios.** `DurableLedger.load` fetches the whole
collection in **one** query
(`packages/addon-pipeline/src/durable/durable-ledger.ts:220`) — today ~16 MB
of JSON (294 k paths × ~55 B); Scenario A ~**460 MB** in one tRPC response,
parsed on the main thread; Scenario B ~**5.9 GB**, an OOM before the index
exists. Then `SegmentHourLedger.hydrateIndex`
(`packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:342`)
replays every hour into the index synchronously — no yield anywhere in the
loop, and `hydrateHour` is called from the same turn as
`recorder/addon/index.ts:1484`. Today that is ~0.3–0.6 s of blocked loop per
boot (×7 boots this morning); Scenario A ~10–20 s; Scenario B minutes. An
addon deploy restarts the runner, so this is a recurring tax, not a one-off —
today's storm proved the failure mode at 1/27th of the projected size.

**Verdict on the operator's number:** the 25 GB figure is the right answer to
the wrong-shaped present (the mix changed under him two days ago), but the
conclusion it supports is correct in both scenarios: *nothing bounds either
structure except footage leaving the disk, so the heap is sized by the disk* —
and a disk-sized heap is unacceptable at any bitrate mix once the disk is
30 TB.

---

## 3 · What the index must answer — every caller, and its coarsest sufficient granularity

> **Re-read against the code on 2026-08-30, after D287 shipped, and it needed
> more than a refresh.** The table below was written when the index still held
> the whole archive, so it asks "what granularity does this caller need". After
> D287 the prior question is "does this caller think the index is the archive",
> and for four of them the answer was yes. §3a is that census, with a verdict
> per caller. D295 is the rule it produced.

The operator's instinct ("non a questa granularità" [not at this granularity]) tested against every call
site. Three callers genuinely need 10-second resolution — but only inside the
window being viewed. Every always-resident consumer needs hour granularity or
coarser.

| Caller | Site | Question | Coarsest granularity that answers it | Needs residency? |
| --- | --- | --- | --- | --- |
| Scrub/seek locate | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:905` | which segment covers epoch; forward/backward covered edge | **segment**, within ±60 s of the cursor (`LOCATE_HYDRATE_MARGIN_MS`) | window only |
| Segment/GOP/window byte reads | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:639` | one row by exact `(device, profile, startMs)` | **point lookup** | no — O(log n) on a view, or one hour-row parse |
| Playback manifest | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:507` | segments overlapping `[from,to)`, per profile | **segment**, window only | window only |
| Timeline availability | `packages/addon-pipeline/src/recorder/addon/calendar-index.ts:511` | exact ranges, 5 s gap merge — an hour hiding a 1 011 s gap must not render solid (`calendar-index.ts:489`) | **segment**, per *viewed* hour | window only — and since D674 the window is clamped to the camera's oldest ledger hour and refused above 8,784 hours; the rung is bounded like the index |
| Days with footage | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:818` | which local days hold anything | **day** | no |
| Coverage/usage page | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:837` | bytes + oldest per device; bytes per volume | **hour aggregates** (volume half is already SQL via `archiveAccounting`; the device half still walks RAM at `recording-provider.ts:849`) | no |
| Retention sweep | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:1104` | oldest-first victims past age/size | **hour stream** + paths of the chosen hours (segment precision only at the cutoff-boundary hour) | no |
| Disk-pressure eviction | `packages/addon-pipeline/src/recorder/storage-evictable-provider.ts:116` | domain total; oldest to cover N bytes | already SQL (D255) | no |
| Export | `packages/addon-pipeline/src/recorder/addon/index.ts:1034` | segments in the render window | **segment**, window only | window only |
| Redundancy sweep | `packages/addon-pipeline/src/recorder/addon/index.ts:1586` | recent-window duplicates | **segment**, lookback window | live tail |
| Still frames | `packages/addon-pipeline/src/recorder/addon/index.ts:1120` | low segment covering one epoch | **point lookup** (today: full device-low copy + linear scan in `still/still-source.ts`) | no |
| Latest finalized end | `packages/addon-pipeline/src/recorder/addon/footage-render.ts:244` | newest low row | **one scalar** (`maxStartMs`) | no |
| Placement demand | `packages/addon-pipeline/src/recorder/addon/index.ts:1836` | bytes/day per (device, profile) | **hour aggregates** | no |
| Rebalance piles | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:720` | bytes+files per (device, profile, location) | **hour aggregates** | no |
| Evict bucket census | `packages/addon-pipeline/src/recorder/segment-store.ts:187` | segments per hour-bucket dir | the hour row's `segments` column *is* this number | no |
| Footprint delete / rescan | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:1088` | whole device | operator-armed batch walk | no |
| Ledger reconcile after walk | `packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:569` | index vs ledger diff | follows the walk it serves | no |

**Position.** The operator is right about residency and half-right about
granularity: per-10-second detail is load-bearing for seek, gap rendering and
GOP reads — the product would be worse without it — but no caller needs it
resident beyond (a) the live tail and (b) the windows an operator is actually
looking at. Everything always-on is an hour-level question. And the *database*
does not need per-segment rows either: a point lookup is "fetch the hour row,
parse ≤ 360 paths" — the filename already encodes start/dur/bytes, so the hour
row's `paths` blob is a perfectly good detail record.

---

## 3a · The residency census — every caller, re-read after D287 (2026-08-30)

Verdicts against the code as it stands, not against the table above. **Broken**
= it assumes the whole archive and since D287 it silently sees a fraction.
**Correct** = it asks about the live tail or a window it hydrated first, and the
tri-state renders honestly. **Ambiguous** = the answer depends on something not
settled here.

| # | Caller | Site | Verdict | Note |
| --- | --- | --- | --- | --- |
| 1 | Relocate work list | `packages/addon-pipeline/src/recorder/relocate-engine.ts:318` | **BROKEN — fixed** | The one that fired. Now `SegmentHourLedger.streamSegments`, paged; the RAM read survives only as the announced no-ledger fallback. |
| 2 | Retention prune selection | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:1111` | **BROKEN — fixed** | §P4's caller. Now `selectEvictionsFromArchive`, bounded per pass; a node with no ledger REFUSES rather than pruning from residency. |
| 3 | Retention floor after prune | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:1119` | **BROKEN — fixed** | `accounting(deviceId).oldestMs` is "the oldest row this process holds", which on a cold camera is minutes ago and renders as "retention is working". Now the census's `oldestMs`. |
| 4 | Footprint delete | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:1147` | **BROKEN — open** | "Delete all footage" deletes the resident share and reports `deletedBuckets` for it. Same fix as #2 (`streamSegments({ deviceId })` + a window filter); not in the first change because the first change already alters two delete paths and this one is operator-armed and rare. |
| 5 | Usage page, per-camera bytes + oldest | `packages/addon-pipeline/src/recorder/addon/device-storage-usage.ts` | **BROKEN — fixed (D418)** | It cost a day on 2026-09-09: 60.5 GB and "oldest three hours ago" beside a volume row saying 1.9 TB, read by two people as retention eating recent footage. Now `SegmentHourLedger.usageByDevice` — a fold over the always-resident T1 hour summary, ONE pass for every camera and no I/O. NOT `census({ deviceId })` per camera: `predicate` takes one `locationId`, so that is `cameras × volumes` aggregates per click, and the device-only form would count footage on locations that no longer resolve. Residency is still reported, as `residentBytes` / `residentOldestMs`. |
| 6 | Usage page, which cameras have footage | `packages/addon-pipeline/src/recorder/addon/device-storage-usage.ts` | **BROKEN — fixed (D418)** | A camera nobody viewed since boot used to vanish from the page. The census is now the key set of `usageByDevice`, so a camera whose footage is entirely cold is listed with its real bytes. `RecordingIndex.deviceIdsOnLocations` had no other caller and was DELETED with its licence. |
| 7 | `RecordingStatus.storageBytes` | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:591` | **BROKEN — open, reports only** | The last one. `statusFor` is synchronous and on a per-device poll, so it wants a device-scoped fold rather than the whole-mirror one #5 uses; it acts on nothing, and D418 names it as the next. |
| 8 | Rebalance source piles | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:721` | **BROKEN — open** | `piles()` under-reports cold cameras, so the plan proposes FEWER moves than it should. It never proposes a wrong one, and each move it does propose now runs on the archive-backed mover. |
| 9 | Placement work set + demand rate | `packages/addon-pipeline/src/recorder/addon/index.ts:1905` | **BROKEN — fixed** | The work set is now `SegmentHourLedger.profilesWithFootage`, a fold over the always-resident T1 hour summary, and the write MERGES (`writePlacementPass`) instead of replacing the fleet-wide record with a work-scoped plan (D299). Not `census` per pair: that is one serial UDS round trip per (camera, profile) on a 30 s tick, 48 for today's fleet and growing — T1 is resident precisely so an O(writers × days) question costs no I/O. The *rate* half (`dailyBytesFor`) still reads the index and is not a defect: it is self-normalising over whatever window is resident, and it is the only thing the narrowed allowlist entry still licenses. |
| 10 | Evict bucket census | `packages/addon-pipeline/src/recorder/segment-store.ts:187` | **Correct (failure direction is safe)** | Under-residency makes the count short or zero and `bucketFullyEvicted` returns `false` — a leftover empty directory, never a directory removed while it still held files. |
| 11 | Ledger reconcile after a walk | `packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:1257` | **Correct** | Runs only after `hydrateDeviceFromStorage` walked that device end-to-end; the walk IS the archive for those devices, and D148's refusal machinery covers a walk that saw too little. |
| 12 | `rescanStorage` `itemsAffected` | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:1097` | **Correct** | Follows the same whole-device walk. |
| 13 | Playback manifest profile set | `packages/addon-pipeline/src/recorder/addon/recording-provider.ts:528` | **Correct (over-broad)** | Hydrates the window first, then reads the whole device to derive profiles. Surplus rows, never a shortfall. |
| 14 | Export window read | `packages/addon-pipeline/src/recorder/addon/index.ts:1069` | **Correct (over-broad)** | Same shape: `hydrateWindowFromStorage` then `segments(deviceId, profile)`. |
| 15 | Range/manifest/locate/edge reads | `recording-provider.ts:401`, `:911`, `:925`, `:929`, `:930` | **Correct** | Each gates on `hydrationOf` and hydrates the window first. |
| 16 | Timeline availability | `packages/addon-pipeline/src/recorder/addon/calendar-index.ts:127` | **Correct** | Returns `null` for an unhydrated hour, which falls through to the directory read. The tri-state does exactly its job here. |
| 17 | Redundancy sweep | `packages/addon-pipeline/src/recorder/addon/index.ts:1622` | **Correct** | Lookback window over the live tail by construction. |
| 18 | Latest finalized end | `packages/addon-pipeline/src/recorder/addon/footage-render.ts:249` | **Correct** | The newest row is always write-through resident. |
| 19 | Disk-pressure eviction | `packages/addon-pipeline/src/recorder/storage-evictable-provider.ts:116` | **Correct** | Already SQL since D255 — `accountingForLocations` + `oldestSegments`. The template the two fixes above follow. |
| 20 | Still-frame source | `packages/addon-pipeline/src/recorder/addon/index.ts:1148` | **AMBIGUOUS** | `segmentsOverlapping(deviceId, 'low', epochMs, epochMs + 1)` with NO hydrate first, unlike every other window read. Pre-D287 the boot replay made it work; today a still for a cold hour returns "no segment covers this instant". What would settle it: whether the export dialog's start/end previews are ever asked for an instant outside a window the timeline already hydrated. If they are, it needs the same `hydrateWindowFromStorage` the export path does — one line. |
| 21 | Legacy availability / days fallbacks | `recording-provider.ts:810`, `:831` | **AMBIGUOUS (dead in production)** | Both read `segments(deviceId)` unhydrated, and both are `deps.calendar === undefined` branches. What would settle it: whether any node runs without the calendar index wired. If none does, delete the branches — they are a second implementation of the timeline that nobody exercises. |

**How to keep this honest.** `scripts/check-recorder-index-residency.ts` is the
part that does not rot: every `archive-shaped` read of `RecordingIndex` must be
in its allowlist with a reason, and every public method must declare a
`@residency` verdict. Rows 4–8 above are entries in that allowlist today, which
is why they are visible at all; row 9's entry survives its fix, narrowed to the
demand rate alone.

---

## 4 · What must be in RAM at all, versus queried

Positions, with costs:

1. **Hour aggregates: RAM, always.** ~200 B × (writers × 24 × retention-days):
   47 k rows ≈ **~10 MB** at Scenario A, ~75 k ≈ 15 MB at Scenario B. O(days),
   not O(segments) — this is the tier that makes 30 TB irrelevant to the heap.
   It also keeps D49 satisfied: every *gate* (`recordSegment` dedup, prune
   refusals, hydration tri-state) still answers from RAM.
2. **Segment detail: RAM only for the live tail and viewed windows, evicted.**
   A hard cap of ~512 resident hours (≈ 180 k rows ≈ **~40 MB**) covers a
   scrubbing operator with generous margin (a day of one camera is 48
   device-hours; the calendar already warms adjacents). Cold miss = one SQL
   point read of an hour row (~10–100 KB blob, indexed by PK) — milliseconds,
   and against the settings DB, **not** against the (currently slow) media
   array. That is strictly better than today's cold path, which is a `readdir`
   on the array measured at ~650 ms per hour under load
   (`calendar-index.ts:7`).
3. **Every archive-wide question: a query, never a walk.** Totals are
   `aggregate` (exists, D255); oldest-first is `orderBy+limit` (exists, D255);
   per-device/per-profile totals need either one `aggregate` per device (16
   calls per usage-page load — acceptable) or a `groupBy` field on
   `settings-store.aggregate` (the one API addition this design would ask of
   the framework train; until it ships, the per-device loop serves).
4. **The whole-archive in-memory mirror should not exist.** Not the index's
   copy (bounded per items 1–2) and not the `DurableLedger` mirror's `paths`
   arrays — the mirror keeps every path string of the archive alive forever
   (`packages/addon-pipeline/src/durable/durable-ledger.ts:175` holds full
   rows; nothing evicts). The ledger's decision paths need the *aggregate*
   half of each row, not the paths: `recordSegment`'s dedup gate can answer
   from the live tail, `dropSegments` receives its paths from the eviction
   read that chose them, and the prune-refusal magnitude guard counts rows.

---

## 5 · The tiered shape

Builds on ADR-0255 (archive scalars are SQL) and the existing tri-state
hydration (`unknown / partial / hydrated`,
`packages/addon-pipeline/src/recorder/recording-index.ts:14`) — the tri-state
already makes eviction *semantically free*: an evicted hour returns to
`unknown`, which every read path already treats as "walk it on demand".
D255's Consequences paragraph explicitly deferred the residency decision; this
is that decision.

| Tier | Contents | Residency | Bound | Eviction rule |
| --- | --- | --- | --- | --- |
| **T0 — live tail** | `SegmentRow`s of the current + previous hour per active writer, write-through from `onFinalized` | RAM, always | ~2 h × 30 writers × ≤360 ≈ 21 k rows ≈ **5 MB** | rolls off as hours close (rows migrate conceptually to T2/T3; the hour-close upsert to T3 already exists) |
| **T1 — hour summary** | per (device, profile, location, hour): `bytes, segments, minStartMs, maxStartMs` — the ledger mirror **minus `paths`** | RAM, always | O(writers × days): **~10–15 MB even at 30 TB** | never evicted; dropped when the hour is confirmed gone (existing D148 rules unchanged) |
| **T2 — segment detail** | per hydrated (device, profile, hour): the sorted `SegmentRow` slice, loaded on demand | RAM, windowed | LRU over resident hours, hard cap (~512 hours ≈ **40 MB**) | LRU hour → removed from `byDevice` + its `walked` bucket → state returns to `unknown`; never evict the T0 window or an hour with an in-flight read |
| **T3 — durable archive** | `recorder:segment-hours` exactly as today: `paths` blob + derived aggregates, PK + `(locationId, hourStartMs)` index | SQLite (settings store) | disk | existing retention semantics (D148: forgotten only when a trusted walk or eviction confirms) |

Detail-fetch order for a cold hour: **T3 hour row first** (fast, off-array),
`readdir` fallback only when T3 has no row (pre-ledger footage, ledger loss) —
the same fail-toward-walk direction the ledger already documents. The
existing hydration entry points (`hydrateWindow` at
`recording-provider.ts:391`, `hydrateWindowFromStorage` at
`packages/addon-pipeline/src/recorder/addon/roots.ts:342`) keep their
signatures; only their first stop changes.

What this deletes: `hydrateIndex` replaying the archive at boot, the mirror's
path retention, and the last reasons any caller touches
`index.segments(deviceId)` whole-device (§3 table, "no" rows).

Heap after: **T0 + T1 + T2 ≈ 55–70 MB, independent of archive size.** The
recorder's heap stops being a function of the disk.

Consistency notes (the rules this must not break):

- **D49** — no gate consults SQLite. All gates live in T0/T1. A T2 cold read
  that fails serves `unknown`, which callers already render honestly
  (`RangeSegments.hydration`, `recording-provider.ts:362`).
- **D148** — eviction of a T2 hour destroys nothing durable and cancels
  nothing; it forgets a *cache* entry. The ledger prune rules are untouched.
- **D8/D11** — no new event topics; T2 misses are reads, not telemetry.
- The cap surface does not change; this is all inside the recorder process
  (D2 untouched).

---

## 6 · The boot path

> **SHIPPED 2026-08-29 — stage 2 is in the tree (D287).** Measured on a
> synthetic ledger at both sizes, boot → first locate:
>
> | | today (1 507 hours / 295 k segments) | 28 TB scenario A (47 k hours / 8 M segments) |
> | --- | --- | --- |
> | wire payload | 17.7 MB → **0.4 MB** | 479.3 MB → **11.3 MB** |
> | ledger load | 256.5 ms → **2.7 ms** | 12 095 ms → **97.6 ms** |
> | longest synchronous block | 256.5 ms → **0.3 ms** | 12 095 ms → **1.6 ms** |
> | boot → first locate | 257.7 ms → **3.0 ms** | 12 133 ms → **101.3 ms** |
> | heap retained by the load | 135.3 MB → **2.2 MB** | 1 679.9 MB → **51.2 MB** |
>
> The 479 MB confirms this section's ~460 MB projection to within 4%, and the
> 12.1 s confirms the "~10–20 s" it predicted.
>
> **One thing this section got wrong, found on the way.** Step 3 below says the
> first locate of *any* hour pays a T3 point read. That is right for a CLOSED
> hour and wrong for the LIVE one: the live hour's durable row is knowably
> behind the disk (a segment finalized after the last persist and before a
> crash is on the array and not in the row), so serving it from T3 would
> rebuild, one level down, exactly the invisibility that marking every ledger
> hour `hydrated` created. The live hour is excluded from the ledger-first
> path and still walked, once per process; a closed hour already walked is not
> re-read, which is what keeps that exclusion affordable. See D287.
>
> Also shipped with it, from
> [reference-nvr-recording-model](2026-08-29-reference-nvr-recording-model.md)
> §4.2: the storage fallback now upserts a CLOSED hour the ledger never held,
> so a cold hour with no ledger row stops paying a `readdir` forever.

**Minimum the recorder must know before serving its first request:** its
storage locations, per-device configs, and — for honesty, not correctness —
nothing else: the tri-state means an empty index answers "unknown, walking
now", which is already the shipped behaviour for hours the ledger never held.

Boot becomes:

1. Resolve locations, start writers (already first —
   `recorder/addon/index.ts:1544` comment "Start the WRITE path FIRST").
2. Load **T1 only**: one query with `columns:
   [deviceId, profile, locationId, hourStartMs, bytes, segments, minStartMs,
   maxStartMs]` — no `paths`. ~47 k skinny rows ≈ a few MB, parsed in chunks
   with yields. The `columns` projection already exists on the query surface
   (used at `segment-hour-ledger.ts:174`).
3. Mark ledger-known hours as *hydratable-from-T3* (a T1 flag), **not**
   `hydrated` — hydrated now means "T2 holds the rows". First locate of any
   hour pays one point read.
4. Everything else — `warmToday`, exports bootstrap, sweeps — unchanged and
   already deferred.

Restart cost at 30 TB: **~100 ms of ledger load and zero archive replay**,
versus today's growing synchronous hydrate. Ten restarts an hour — today's
measured storm — becomes survivable, which the constraint list is right to
demand: a deploy restarts this runner routinely.

Interim/slow-disk note: nothing above requires fast media storage. The one
assumption is that the settings-store SQLite lives off the media array (hub
data dir); if it does not, T2 cold reads inherit array latency and the design
degrades to today's readdir behaviour — no worse, but verify before staging
(§10).

---

## 7 · Steady-state CPU — separate, real, and fixable without the redesign

These three (plus two neighbours found on the way) explain a large share of
the 48.7 % GC and are each shippable alone. None depends on §5.

1. **`recordSegment` re-derives the whole hour per finalize — O(N²) per hour.**
   `segment-hour-ledger.ts:508` → `segmentHourRow` → `hourAggregate`
   (`segment-hour-ledger.ts:107`) regex-parses *every* path of the hour on
   *every* append, then `rowToValue` JSON-stringifies the whole `paths` array
   for the persist. Σ1..360 ≈ 65 k parses per camera-profile-hour at 10 s
   segments (storm hours: Σ1..1708 ≈ 1.46 M), plus a growing JSON blob per
   finalize, ~3.4 finalizes/s fleet-wide, forever. Fix: incremental append —
   the aggregate of `paths + [p]` is four scalar updates from `parseSegmentPath(p)`.
   `hourAggregate` stays the sole *full* derivation (rebuilds, `recordToRow`),
   preserving the "derived by one function" invariant; a test pins that
   incremental == full on random hours. Optionally coalesce the persist per
   hour (`stage` + periodic flush, the stationary-registry pattern at
   `durable-ledger.ts:341`) — failure direction is under-reporting, which
   prunes less, and is documented in the `@durable` annotation.
2. **`resolveSegmentFile` copies the device archive per segment read.**
   `recording-provider.ts:645` calls `index.segments(device, profile)` — a
   full array copy (`recording-index.ts:330`) — then linear `.find` — on
   *every* `readSegmentBytes` / `readGopBytes` / `readWindowBytes`, i.e. every
   scrub tick and every playback fetch. `segmentAt(device, profile, startMs)`
   already exists and binary-searches the live view
   (`recording-index.ts:526`); an exact-start variant is O(log n) and
   zero-copy. Same medicine for the still service (`still-source.ts` linear
   scan over a full copy → `segmentAt`) and `latestFinalizedEnd`
   (`footage-render.ts:244` → last element of the sorted view).
3. **`coveredEdgeBefore` linear-scans per gap locate.**
   `recording-index.ts:551` walks the whole sorted view; it is called on every
   locate that lands in a gap (`recording-provider.ts:930`), which during a
   drag across sparse footage is every tick. It is a binary search
   (upper-bound on `startMs`, then a bounded backward walk over the few
   overlapping candidates).
4. **`collectRangeSegments` copies + re-sorts the archive per call.**
   `recording-provider.ts:397` does `segments(device, profile)` (copy) →
   `.filter` → `.toSorted` (the view was already sorted) per playback/export
   call. `segmentsStartingIn` (`recording-index.ts:337`) slices the live view;
   it needs only an overlap-inclusive variant (start the slice one element
   earlier to catch a segment straddling `fromMs`).
5. **`getStorageUsage` walks and sorts per location.**
   `recording-provider.ts:842` materialises `segmentsOnLocation` (full
   multi-device copy + sort, `recording-index.ts:475`) just to learn *which
   devices exist*, then walks per-device accounting at
   `recording-provider.ts:849`. Both are T1/SQL questions today (D255's own
   aggregate, filtered per device).

Expected effect: items 1–4 remove the per-second and per-tick allocation
churn that GC is billing at ~49 % of a core; item 2–3 also shorten the scrub
critical path. Measured by: `cpuGcPercent` for the recorder in
`listNodeProcesses`, the `[mem]` `loopMax` series, and the `heapUsed` floor
five minutes after a boot. **Stage 1 is also the diagnostic**: if the
`heapUsed` floor does not fall materially after it ships, the unexplained
retained set is real and a heap snapshot becomes mandatory before sizing
stage 3 (§10).

---

## 8 · Staged plan — cheapest first, each independently shippable and measurable

All stages are recorder-local (`camstack deploy packages/addon-pipeline`),
none changes a cap surface, and each is revertible alone. Baseline metrics
before each stage: `cpuGcPercent`, `loopMax` p/max, `heapUsed` floor at
boot+5 min, first-locate latency per device (`tags: { deviceId }`).

| Stage | Change | Measures | Expected | Interim note |
| --- | --- | --- | --- | --- |
| **1** | §7 items 1–5: incremental hour aggregate; exact-start lookup for byte reads + stills + latest-end; binary-search `coveredEdgeBefore`; slice-not-copy in `collectRangeSegments`; SQL device census in `getStorageUsage` | GC share, `loopMax`, heapUsed floor | GC ≪ half; steady-state 2 s stalls shrink or vanish; scrub tick cheaper | fully valid on the slow disk — touches no I/O |
| **2** | Skinny boot: T1-only load (`columns` projection, chunked with yields); delete `hydrateIndex`'s archive replay; ledger-known hours become hydratable-from-T3, first read pays one point read | boot-to-first-locate, boot heap, ledger-load ms, restart-storm survivability | restart cost flat in archive size; today's 0.3–0.6 s hydrate stall → ~0; at 30 TB avoids the 460 MB–5.9 GB boot query | valid now; **prerequisite** for attaching 30 TB |
| **3** | T2 windowed residency: LRU cap on resident hours; mirror sheds `paths` (T1 = aggregates only; `recordSegment` gates on T0, `dropSegments` uses the eviction read's paths); T3 point-read as the cold-hour detail source with readdir fallback | heapUsed vs a `residentHours` counter; cold-hour locate latency p99 | heap independent of archive size (~55–70 MB for the index complex); cold miss ~ms against the settings DB instead of ~650 ms array readdir | verify settings-DB placement first (§10); readdir fallback keeps slow-disk behaviour as the floor |
| **4** | Retire the last whole-archive walks: retention `selectEvictions` → bounded oldest-first hour stream per device (same statement shape as D255's `oldestSegments`, filtered by device + cutoff); playback profile derivation (`recording-provider.ts:527`) and days fallback from T1; `piles`/`accountingByProfile` from T1 | retention-sweep duration, allocations per sweep | retention on a 60-day archive stops copying+sorting millions of rows per device per hour (`recording-provider.ts:1111`, `evict-select.ts` copies+sorts whole-device twice) | stage 4 is what makes *retention itself* O(victims) at 30 TB |

Stage order is deliberate: 1 needs no design agreement and pays immediately;
2 removes the boot hazard before the array arrives; 3 is the residency bound;
4 finishes the "aggregate questions are queries" programme D255 started.
After 4, `RecordingIndex` is T0+T2 and nothing in the recorder is O(archive)
on any hot path.

What is *not* proposed: per-segment rows in SQLite (unnecessary — §3), a new
process (D2), any change to what is kept (retention semantics untouched;
the sweep still only prunes devices with an explicit policy,
`retention-sweep.ts` `hasRetentionPolicy` — note that today **no sampled
device has one**, so the 1 TB quota is the only working bound; at 30 TB the
operator should set age policies deliberately rather than inherit
"disk-full-first").

---

## 9 · What would falsify this design

- **The heapUsed floor survives stage 1.** If, with the churn sources removed,
  the recorder still floats >1 GB at 0.3 M rows, the heap has a retained
  component this analysis did not locate, and stage 3's "55–70 MB" sizing is
  built on sand. Falsifier action: heap snapshot on a staging replica before
  stage 3.
- **T3 point reads are not milliseconds.** If the settings-store SQLite shares
  the media array, or checkpoint contention (D96) puts p99 of a PK read above
  ~50 ms under scrub load, cold T2 misses eat the feeder's budget. Mitigation
  is adjacent-hour prefetch (the calendar already warms adjacents); failing
  that, the detail tier must live in its own read path, which is a bigger
  design.
- **A caller that needs whole-archive segment detail synchronously.** §3
  found none; a new one (e.g. a global "every gap this month" export) would
  have to be a paged query by construction, or it breaks the T2 bound.
- **The 462 GB/day rate is not representative.** Retention-days and row counts
  in §2 scale linearly with it. A fleet doubling, or a re-tune to Scenario B's
  mix, moves the numbers but not the conclusion — hour-row counts scale with
  writers × days, never with bitrate, which is precisely why T1 is the safe
  resident tier.
- **`loopMax` 2 s+ persists after stage 1+2 with a small heap.** Then the
  stalls were never GC, and something synchronous and periodic is still
  unaccounted — profile before proceeding.

---

## 10 · What could not be determined

- **The composition of today's 1.4–1.8 GB `heapUsed`.** Segment rows account
  for ~66 MB; external/arrayBuffers ~0. The remainder is attributed to
  allocation churn + un-collected garbage on the strength of GC share, the
  refill-in-5-minutes curve, and code-visible churn sources — but no heap
  snapshot was taken against production, so "1.3 GB of churn floor" vs "a
  retained structure nobody has named" is unresolved. Stage 1 doubles as the
  experiment.
- **Whether the recurring `loopMax` 2.1–2.8 s is GC.** Strongly implied
  (first post-boot sample reads 353 ms; the stalls appear once `heapTotal`
  passes ~2 GB), not proven.
- **Where the settings-store SQLite physically lives** (hub data dir vs the
  recordings array). Determines T2 cold-miss latency; must be checked before
  stage 3.
- **The exact 08-27 archive** (D255's 7.1 M rows) versus today's 294 k: the
  quota-driven mass eviction between 08-27 and 08-29 is inferred from the ops
  log's continuous `quota` prunes and the 08-27 02:00 oldest-hour edge, not
  reconstructed event by event.
- **The operator's intended recording mix at 30 TB** (Scenario A vs B — §2
  differs 12× in row count). The design is sized to survive both; the boot
  and residency bounds are mix-independent by construction.
- **`settings-store.aggregate` has no `groupBy`** (verified against
  `packages/types/src/capabilities/settings-store.cap.ts:327`), so per-device
  archive totals are N aggregate calls until a framework train carries the
  extension; acceptable at N=16, worth the API addition eventually.
