---
title: Execution plan 2026-08-29 — memory and CPU, ranked by arithmetic
covers:
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/evict-select.ts
  - packages/addon-pipeline/src/recorder/addon/recording-provider.ts
  - packages/addon-pipeline/src/recorder/recording-index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/native-frame-transport.ts
  - packages/system/src/kernel/socket-plane-report.ts
  - packages/system/src/kernel/transport/socket-traffic.ts
  - packages/system/src/kernel/heap-watch.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-pragmas.ts
---

# Execution plan 2026-08-29 — memory and CPU

> Companion to the
> [checkpoint](./2026-08-29-memory-cpu-checkpoint.md), which holds the
> evidence; this document holds the work, graded. Grades:
> **[FIX]** confirmed cause → ready to implement, file and change named;
> **[EXP]** named suspect → cheapest experiment first, with the result that
> convicts or acquits; **[PARK]** speculative, kept only with its promotion
> condition. Items are ranked by expected effect **with arithmetic**; the
> confidence column is honest, and a ranked plan with honest confidence beats a
> confident wrong one — that is the day's clearest lesson.
>
> Standing constraints honoured throughout: no ceiling is raised or tuned
> (`--max-old-space-size`, `rssBudget`, `MALLOC_ARENA_MAX` are earned out of
> existence, never adjusted); no new mechanism where one exists; no new event
> topics; every fan-out judgement per peer; before new instrumentation, the
> unread counter that already exists.
>
> **Ship chains** (current: `@camstack/server` 1.2.190, `@camstack/system`
> 1.2.155, `@camstack/addon-pipeline` 1.2.146): addon changes are
> `camstack deploy packages/<addon>`; anything in `packages/system` or
> `server/backend` travels only inside the published `@camstack/server`
> closure — a **publish train**, live only when a containing server is
> installed. Items P1b and P7 below are the train riders; batch them.

---

## The ranking, in one table

| # | Item | Grade | Expected effect (arithmetic) | Confidence | Ship chain |
| --- | --- | --- | --- | --- | --- |
| P1 | The 236 kB responses to `pipeline-analytics` through hub-main | EXP → then fix at the caller | 536 MB/min at tonight's peak, 81 % of hub-main's outbound response bytes; the churn behind the 181–330 MB/min ArrayBuffer slope, the ~2-min reclaim cadence and its 555–869 ms stalls, and the one rssBudget crossing | mechanism high; method attribution pending | experiment: read-only / small; fix: `camstack deploy packages/addon-post-analysis` (likely) |
| P2 | `oldestSegments` selects a full 32-hour page to delete two segments | FIX | −~250 KB/s of the recorder's 400 KB/s priced allocation (63 %); rounds 570–15 436 ms shrink ~16×; mirror staging ceiling 23 MB → ~KB today, **~600 MB → ~KB at 30 TB** | high | `camstack deploy packages/addon-pipeline` |
| P3 | Name the recorder's ~1.2 GB retainer (and with it the 2.0–2.6 s synchronous block) | EXP (snapshot, operator-armed) | unlocks ~1.2 GB on the fleet's largest JS heap and the recurring 2–3 s stalls on the recording path; nothing else on this list touches either | that it exists: high; what it is: zero | none (env flag + SIGUSR2, already gated) |
| P4 | Stage 4 — retention reads leave the RAM index (correctness prerequisite) | FIX | prevents silent under-pruning the day age policies are set; removes the last two whole-device copy+sorts (`evict-select.ts:10`, `evict-select.ts:50`) | high (verified in source tonight) | `camstack deploy packages/addon-pipeline`; **gates the 30 TB retention policies** |
| P5 | sqlite-settings' native RSS: verify it is the configured mmap | EXP (one read) | expected outcome: item closes as "working as configured"; prevents a future false OVER RSS BUDGET hunt as the DB grows with the archive | high | read-only ssh |
| P6 | `segmentAt` reports a gap over footage that exists (overlap) | FIX | correctness, operator-visible; zero memory | high | `camstack deploy packages/addon-pipeline` |
| P7 | category→children index for the event plane | FIX, deliberately queued | −~5 300 decisions/s of the ~5 660 remaining (94 % waste post-R1); CPU value modest — sub-µs pattern checks, order 0.3–0.5 % of a core | high on mechanism | publish train (`packages/system`) |
| P8 | hub-main's 44 k syscalls/s, ~95 % not frames | EXP | attribution only; no intervention proposed until named | medium | read-only host sample |
| P9 | hub-main's ~1.5 GB live old_space | PARK | — | — | promotion condition below |
| P10 | 24–48 h heartbeat read | EXP (zero code) | converts every single-boot conclusion into a daily-rhythm one | — | none |
| P11 | Writer-restart baseline read before the array | EXP (zero code) | preserves the ability to attribute the storms to the disk | — | none |
| P12 | Coalesce the recorder's hour persist | FIX, measure-first | −~3.6 GB/day of row rewrites into the checkpoint lottery (D96); unblocked by D287 | medium | `camstack deploy packages/addon-pipeline` |

Where this ranking disagrees with the operator's (1: 133 kB responses, 2:
recorder synchronous block, 3: sqlite-settings native): **#1 agreed and now
larger than briefed** (236 kB / 536 MB/min tonight). **#2 agreed but it is not
a separate hunt** — the block scales with the heap and is not GC, so naming the
retainer (P3) is the same investigation; a standalone "find the block" effort
would duplicate it. **#3 demoted**: the 1.2 GB has a name in source
(`sqlite-pragmas.ts` mmap sizing, checkpoint E10), tonight's live reading is
349–481 MB, and what remains is a one-read verification plus an accounting note
— not a fleet-scale lever. Promoted into its slot: P2 (a confirmed defect with
a one-line core fix) and P4 (a correctness gate the 30 TB plan steps on).

---

## P1 · The analytics media plane through hub-main — attribute, then move less

**What is measured** (checkpoint E4): hub-main answers ~2 267 requests/min from
`pipeline-analytics` with ~236 kB mean responses — 536 MB/min tonight,
253 MB/min in the afternoon window. Each response costs hub-main a decode-side
Buffer and an encode-side `Buffer.allocUnsafe` copy
(`packages/system/src/kernel/transport/frame-codec.ts:16`), and on the analytics
side a ≥131 072 B allocation that lands directly in `large_object_space`. This
is the router's byte plane, its ArrayBuffer churn, and its reclaim cadence.

**Leading hypothesis (unproven — this is the experiment):** native crop /
keyFrame JPEG fetches by handle for enrichment — the fetch sites are
`packages/addon-post-analysis/src/pipeline-analytics/runtime/native-frame-transport.ts:548`
and its callers (face/plate/clip/detail, best-shot). Enrichment crops are
native-strict by contract, and a native-tier crop from a 4K raster is
100–400 kB. ~38 fetches/s is inference-rate-shaped (48.9 runs/s measured this
afternoon, load −59 % later).

**The experiment, cheapest first:**

1. **Read the unread counter.** `system.getRequestCensus` exists
   (armed via a `request-census` window; the arming is a hub write the operator
   performs, the read is GET). If its breakdown reaches method level, the
   attribution is free and step 2 is skipped.
2. **If not: a top-N method histogram on large response frames.** The response
   write site knows the method; count `(method, bytes)` for res frames
   ≥ 64 kB, report top-5 on the existing `socket-plane-report.ts:305` line.
   ~20 lines, same discipline as `recordSocketFrame` (2.4 ns/frame — and at
   ~38 large frames/s the histogram path runs 38×/s, not 44 000×/s). Publish
   train — batch with P7.

**Convicts:** one method ≥ 70 % of large-res bytes, named caller in
post-analysis. **Acquits:** bytes spread across many methods/peers — then the
per-message framing of `hub-main-memory` §4 partially revives and the fix is
elsewhere.

**The fix, once named — move less, not faster.** In order of preference,
because the first respects every constraint and the others need design:
(a) **fetch fewer** — one fetch per *qualifying* detection/track event rather
than per frame, and never re-fetch an unchanged handle (dedupe by
`shmId#slot#seq`, which the log line already prints); (b) **fetch smaller** —
if the model input is downscaled anyway, pass `maxWidth` at the fetch so the
producer scales before the wire (the parameter exists on
`native-frame-transport.ts:525`); (c) only if (a)+(b) are insufficient, a
placement discussion (analytics nearer the frames) — that is a D2/D29
conversation, not a patch, and it is explicitly **not** proposed here. No
queue, no buffer, no transport tuning.

**What breaks:** (a) risks enrichment recall if "qualifying" is drawn too
tight — judge per camera against the existing native-crop hit/miss counter
(`native-frame-transport.ts` bumpCropMetric, per-device). (b) risks model input
quality if `maxWidth` undercuts a model's native input — cap per consumer, not
globally (D52's one-derivation rule is untouched: the crop rect still comes
from `deriveDetailCropRect` at the runner).

**Verify:** per-peer, never aggregate (the day's rule): `socketTop`'s
`pipeline-analytics` kB falls by the predicted share while its *req count*
stays at the qualifying-event rate; hub-main reclaim cadence stretches
(reclaims/hour on the `[mem] reclaim` line); ArrayBuffer slope between reclaims
falls from 181–330 MB/min; enrichment hit-rate per camera flat.

**Expected effect:** the largest single lever on hub-main. If (a) cuts the
fetch count to event rate (~5/s), the response plane drops ~85 % ≈
450 MB/min at peak; the reclaim stops being a 2-minute metronome, which also
removes hub-main's dominant recurring stall (checkpoint E4/E5) — the
"earn the patch out of existence" route for the reclaim and, eventually, the
rssBudget headroom question, without touching either knob.

---

## P2 · `oldestSegments`: break when covered, fetch only what breaks

**Confirmed cause** (verified in source tonight). Phase one's docblock says
"walks oldest-first until the accumulated bytes cover the target"; the inner
loop does not: every record of the 32-row page is pushed
(`packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts:947`) with
no `covered >= targetBytes` break, so phase two
(`segment-hour-ledger.ts:960` onward) fetches all 32 hours **with `paths`**,
JSON-parses ~32 × 14 kB, builds ~6 240 `SegmentRow`s and stages all 32 hours
into the mirror (`segment-hour-ledger.ts:971`) — measured 7.13 rounds/min to
delete **2** segments per round (`recorder-heap` §9.1).

**The change.** In the phase-one record loop, `break` once
`covered >= targetBytes` (the page loop's condition already stops *paging*;
the record loop must stop *choosing*). `chosen` then holds only the hours
needed; phase two and the staging shrink to match. `exhausted` semantics are
untouched — it still means "the stream ran out before the target", which a
break on coverage can never set.

**What breaks:** nothing found. `dropSegments` receives its paths from this
read (D58's shape preserved); an under-covered target still pages up to
`OLDEST_MAX_PAGES`. One behavioural edge to pin in a test: a target covered
mid-page must still return rows spanning ≥ the target (the last chosen hour
may overshoot — that is the existing segment-granular contract).

**Verify:** `recorder: eviction round complete` — `rows` falls from ~6 240-built
to the chosen hours' count; round duration p50 falls from 570–15 436 ms; the
`[mem]` heapUsed floor is **expected NOT to move** (this is 63 % of the priced
allocation, and the priced allocation is 3.6× short of the ramp — say so
before shipping, so the result cannot be over-claimed).

**30 TB note:** this is also the cheap form of stage 3's "mirror sheds
`paths`": staged-hour residency stops scaling with the archive (checkpoint §4).

---

## P3 · Name the recorder's retainer — the snapshot is now cheap to authorise

Both investigation documents converge on this and both of their falsifiers
fired (`togliere-i-tetti` §7 first bullet; `recorder-heap` §11.5). The
prerequisites built today make it a five-minute operator action instead of an
open-ended one:

- ~~The snapshot is **gated and split** from the free breakdown:
  `CAMSTACK_RUNNER_HEAP_SNAPSHOT=on` on the recorder runner + SIGUSR2.~~
  **SUPERSEDED 2026-09-03 — the snapshot is GONE.** The gate was set `on` in
  production, so one SIGUSR2 walked a 1.8 GB heap and took the hub down; the
  second attempt left a 0-byte file and a host that had to be rebooted. The
  writer, the flag and its guard are deleted (guard now:
  `scripts/check-no-heap-dump-command.ts`). The free breakdown survives.
  Allocation SITES are available instead, by sampling, from
  `packages/system/src/kernel/heap-allocation-sample.ts` — which answers where <!-- drift-ok: the sampler was never wired and was deleted 2026-10-06 (D718) -->
  bytes are born, not what retains them. Naming the retainer needs a recorder
  that is not serving cameras.
- What it must produce is already specified — `recorder-heap` §11.4, verbatim:
  (1) enumerate `large_object_space` (≤ 3 657 objects predicted, source
  predicts none — whichever is wrong is the bug), grouped by V8 type and
  attributed to an owning class field; (2) the single largest retained-size
  class and the field that roots it (the reverse-edge procedure that named
  `RtspRestreamer.lastKeyframeRtpPackets` in July); (3) live `SegmentRow`
  count (census says 2 032; millions would convict the counter).
- **Constraint the hunt must satisfy** (checkpoint E8, new): hub-main↔recorder
  wire ≤ ~0.33 MB/s against a 1.43 MB/s retained ramp — the retainer is
  internally generated or decode-amplified ≥ 4×. Start outside the recorder
  tree: runner shell, UDS transport, msgpack decode, logging
  (`recorder-heap` §11.5 already points there).

**P3b — the synchronous block, if it survives the naming.** The 2.0–2.6 s
stall recurs 1–3×/min with `gcMs` ≤ 413 (checkpoint E6) and scaled with the
heap during the ramp — the shape of something periodically walking a
heap-sized structure. Naming the structure most likely names the walker. If
not: one 60 s V8 CPU profile on the runner (inspector; operator-armed, same
authorisation conversation as the snapshot). Do **not** re-open the GC
hypothesis; it is falsified (checkpoint F4).

**Why this is not ranked #1 despite the size:** it is an investigation with an
operator gate, not a shippable change; P1 and P2 produce measured deltas this
week regardless of its outcome.

---

## P4 · Stage 4, upgraded: retention must not read a partial index

**Confirmed by code reading tonight** (checkpoint §4): `pruneFootage` feeds
`selectEvictions` from `deps.index.segments(deviceId)`
(`packages/addon-pipeline/src/recorder/addon/recording-provider.ts:1111`), and
post-D287 that returns only **resident** rows — a policy prune would silently
under-select. Latent only because zero devices declare a retention policy
today.

**The change** (as `recorder-index-at-scale` §8 stage 4 sketched, now with a
correctness reason): `selectEvictions`' age pass becomes a bounded oldest-first
**ledger** stream per device (same statement shape as D255's `oldestSegments`,
filtered by device + cutoff — the SQL and index exist); the size pass takes
per-device totals from the ledger aggregates, not from a RAM fold. The two
`[...segments].toSorted` copies (`evict-select.ts:10`, `evict-select.ts:50`)
disappear with their callers. Same treatment for the three remaining
whole-device reads on the provider (`recording-provider.ts:528`,
`recording-provider.ts:810`, `recording-provider.ts:831`) — each is an
hour-aggregate question.

**What breaks:** the prune-refusal/magnitude guards must keep answering from
T1/T0 (D49 — no gate consults SQLite; the *selection* is a read, the *gate*
stays in RAM). The ghost-location rows (P6-adjacent, see gate G3) must be
reconciled first or the "oldest" the statement returns is a lie.

**Verify:** disarm-style — point a test's index at a partially-resident archive
and require the selection to match the ledger, not the residency; production:
`itemsAffected` on the ops log versus the ledger's own count for a device with
a deliberate 1-day test policy on a disposable camera.

**Sequencing: this gates the 30 TB retention policies (G5). It is not urgent
until the array; it is mandatory before the policies.**

---

## P5 · sqlite-settings — one read closes it

Read `/proc/<pid>/smaps` (or `smaps_rollup`) for the sqlite-settings runner
inside the container during a peak (host `/proc` over ssh, read-only — the same
route the hub-main `/proc/io` work used). **Convicts the mmap:** the
`camstack.db` file mapping's `Rss` accounts for the peak and is majority
`Shared_clean`/`Private_clean` → item closes as *configured behaviour*
(`sqlite-pragmas.ts:60/162/187`), file-backed and kernel-reclaimable.
**Convicts something else:** large anonymous mappings beyond the ~256 MiB page
cache → better-sqlite3 arena/statement growth is real and gets its own
investigation.

**Either way, one accounting note stands:** `rssBudget` compares against total
RSS, and file-backed mapped pages inflate it by design; the DB grows with the
archive (the hour ledger's `paths` blobs alone are ~16 MB today → ~460 MB at
8 M segments), so mmap wanted-size grows toward its 2 GiB ceiling while the
budget is 1 536 MB. The likely first symptom after the array attaches is a
**false OVER RSS BUDGET** on this runner. The honest fix, when it fires, is to
make the *measure* truthful (subtract the file-backed share the watch can read
from `smaps_rollup` once per breach, or annotate the line), not to raise the
budget — raising it is the tuning this plan forbids itself.

---

## P6 · `segmentAt` overlap defect

Pre-existing, operator-visible: the binary search takes the last row starting
at or before the instant and stops, so a short segment starting inside a long
covering one reports a gap over footage that exists
(`packages/addon-pipeline/src/recorder/recording-index.ts:506` area; recorded
in `togliere-i-tetti` §8 and the stage-1 session entry). The machinery to fix
it landed with stage 1: a bounded backward walk under `maxDurMs`, exactly as
`segmentsOverlapping` already does. Small, contained, correctness-only.
Verify with the restart-storm hours (1 708-segment hour `592|high`), which are
overlap-rich by construction. Ship with any P2/P4 deploy.

---

## P7 · The category→children index — queued behind its own instrument decision

The remaining event-plane waste after R1 is ~94 % of ~5 660 decisions/s, and
`event-bus-fanout-load` §7a establishes all of it now needs the one structural
change (address, don't offer — §6). Two reasons it is ranked here and not
higher, both from the corpus: the CPU value is modest (sub-µs decisions;
~0.3–0.5 % of a core), and **shipping it destroys `fanoutSuppressed`** — a zero
that means "no longer computed" is indistinguishable from "nothing wasted", so
the index needs its replacement counter decided first (§7a's own condition).
Decide the counter (e.g. `fanoutAddressed` per child, same line), then build.
Wildcard fallback and the `eventPatterns === null` fail-open survive unchanged.
Publish train — batch with P1's histogram if both are approved.

---

## P8 · hub-main's 44 k syscalls/s — count before instrumenting

New tonight (checkpoint E9): the UDS frame plane is ~1 050 frames/s, ~2 % of
the syscall count; bytes reconcile, counts do not. Before any code: one
read-only sample on the host — `strace -c -f -p <hub-main pid>` for 30 s (or a
`/proc/<pid>/fd` class census correlated with `io` deltas) — splits the ops
among UDS frames, Moleculer TCP (38 per-runner brokers — the candidate that
fits the idle-`ml` 82 msg/s), eventfd/epoll wakeups, and log ingest. No
intervention is proposed until this names the majority; anything earlier is
transport tuning by another name.

---

## P9 · hub-main's live 1.5 GB — parked, with a promotion condition

Growing slowly (1 518 MB tonight vs 1 310 MB this afternoon at t+0), almost all
`old_space`. Known structures sum an order of magnitude short. Parked because
P1 changes this process' whole allocation regime and any snapshot taken now
would be read under churn that is about to change. **Promotion condition:** the
t+0 `heapUsed` after-value on the reclaim line (now on every pass, free) trends
upward across P10's 48 h window → schedule a gated snapshot of hub-main in a
maintenance window (a 1.5 GB heap snapshot stalls the router for seconds; it is
an operator action).

---

## P10 / P11 · Two zero-code reads that time-box everything else

- **P10:** after 24–48 h, re-read the `[mem]` series (hub-main slope between
  reclaims, reclaim cadence, `socketTop` per-peer, recorder floor and census,
  sqlite-settings peaks) — every conclusion in the corpus is a single-boot
  window and the two observed regimes differ 20×. This read either confirms
  the P1 ranking or re-ranks it against a daily rhythm.
- **P11:** read the writer-exit lines (`SegmentWriter ffmpeg exited` with
  `exitCode`/`signal`/`stderrTail`, shipped 08-27, never yet read) **before**
  the array attaches. If the storms are disk-stall-shaped, the array will
  dissolve them and the baseline is the only proof of why.

---

## P12 · Coalesce the hour persist — unblocked, measure-first

D287 removed the blocker (`togliere-i-tetti` §2 ESITO: the live hour is served
from the walk and the writer's own `addSegment`, never from T3, so delayed
persistence is no longer invisible to playback). The change is the
stationary-registry pattern (`durable-ledger.ts:341` `stage` + periodic flush);
failure direction is under-reporting, which prunes less. Worth ~3.6 GB/day of
row rewrites off the checkpoint lottery (D96). Measure first: count
`recorder:segment-hours` `set.mutate`/min before and after; ship alone, not
inside P2's deploy, so the two effects stay attributable.

---

## The 30 TB array — what must be true before, what becomes wrong after

**Gates before attaching (G1–G6):**

| # | Gate | Status |
| --- | --- | --- |
| G1 | Stage 2 (D287) deployed on the hub recorder — boot must not scale with the disk | **done, verified** (census lines live since 14:16Z) |
| G2 | `camstack.db` has a backup — at 28 TB the hour ledger is the only index of the archive, and today **nothing backs it up** (`free-mnt-mixed` §7.0: skip:"yes", no ext volumes, one 36-byte manifest from May) | **open — operator action**, cold-copy procedure already written in that plan |
| G3 | Ghost-location reconcile (2 131 segments / 15.1 GB on dead `recordings:high`): they distort `oldestMs`, and every retention argument after the attach trusts `oldestMs` | open — one-off armed op |
| G4 | `maxUsedGb: 1000` on `recordings:default` raised/lifted deliberately — attaching 30 TB under a 1 TB quota changes nothing (`recorder-index-at-scale` §2) | open — operator decision |
| G5 | **No per-device age policy is set until P4 ships** (checkpoint §4: a policy prune against the demand-populated index under-selects) — this inverts the index doc's §8 advice from "set policies at 30 TB" to "set them only after stage 4" | open — sequencing rule |
| G6 | P2 shipped (cheap, and its mirror-staging ceiling is the term that scales worst: ~600 MB at 8 M segments) | open — this week's deploy |

**What becomes wrong the moment it attaches — measurements to retire:** every
disk-latency-derived number in the corpus was taken against a USB 2.5" spindle
at ~95 % util doing 7–14 MB/s, and must not be quoted afterwards: the ~650 ms
cold-hour `readdir` (`calendar-index.ts:7`), the placement pass's
`enumerateMs` up to 5 001 ms, the eviction-round durations (570–15 436 ms —
partly store-bound), the continuous `quota` nibbling and the 2.3-day effective
retention, the writer-restart storm rate (if disk-driven — P11 is the
baseline), and the write-destination caveat in the reference NVR like-for-like
comparison (`load-ledger.md`, 2026-08-29 entry). **Re-baseline within 24 h of
the attach** — heapUsed floor, `loopMax`/stall lines, census, round durations,
restarts/h — and never compare a post-attach series with a pre-attach one.

**What to watch as the archive grows** (Scenario A: ~60 days, ~8 M segments,
~47 k hour rows): `recorder: index census` `rowSlots` (the stage-3 LRU's
promotion condition, checkpoint §4); the sqlite-settings peak-RSS-vs-budget
line (P5's accounting note — the DB grows ~+0.5 GB of blobs); T1 summary load
at boot (~11.3 MB wire, ~100 ms — already measured synthetic, confirm live).

---

## Explicitly not proposed

Raising or adding any memory ceiling, buffer, queue, or transport tuning
(constraint); removing the `heap-watch` reclaim (on hub-main it is both the
largest recurring stall **and** the only live-set probe — P1 is the route that
lets it stop firing on its own; on the recorder it fired once in six hours and
produced the day's key measurement); a new event topic or a second fan-out
mechanism; `pipeline.trace` gating on a live consumer (a new mechanism —
`event-bus-fanout-load` §7a's verdict stands); segment-length changes
(a real lever, out of scope, parked in `segments-60s.md` per
`togliere-i-tetti` §6); imitating the reference NVR's no-database / no-ceiling /
hour-granular deletion (each rejected with reasons in
`reference-nvr-recording-model` §5); heap snapshots as a first resort anywhere
an unread counter exists.

## What could not be determined (inherited open list: checkpoint §3)

The recorder's retainer and its synchronous block (O1/O2 — P3 is the
instrument); the analytics method (O3 — P1 step 1); the syscall majority
(O4 — P8); hub-main's old-space composition (O5 — parked P9); the daily rhythm
(O9 — P10); the writer-storm cause (O10 — P11); `cpuGcPercent` semantics (O8 —
do not cite it as a criterion anywhere in this plan's verification steps).
