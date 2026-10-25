---
title: Checkpoint 2026-08-29 — memory and CPU, one day consolidated: established, falsified, open
covers:
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/evict-select.ts
  - packages/addon-pipeline/src/recorder/addon/recording-provider.ts
  - packages/system/src/kernel/event-loop-stall-monitor.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-pragmas.ts
  - packages/system/src/kernel/heap-watch.ts
  - packages/system/src/kernel/socket-plane-report.ts
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
---

# Checkpoint 2026-08-29 — memory and CPU, one day consolidated

> **What this is.** The whole of 2026-08-29 produced eight documents that partly
> contradict each other because the day's instruments kept falsifying the day's
> own inferences. This checkpoint says which version won, so no future session
> re-derives a dead hypothesis. It marks; it does not erase — the corpus docs
> carry same-day correction blocks pointing here where a section is void.
>
> **Method.** Everything in §1–§3 was verified against the corpus documents
> tonight, and the four late-day instrument readings were **re-read live from
> Loki this evening** (the `[mem]` heartbeat with `socketTx`/`socketTop`, the
> recorder's `event loop stalled` lines, the `[mem] reclaim … heapUsed=a→b`
> pairs, the `hub/sqlite-settings` heartbeat). Where tonight's reading differs
> from the number in circulation, both are given. No hub state was mutated; no
> source code was changed.
>
> The companion executable plan is
> [2026-08-29-memory-cpu-execution-plan.md](./2026-08-29-memory-cpu-execution-plan.md).

---

## 1 · Established — measured, with evidence and confidence

| # | Fact | Evidence | Confidence |
| --- | --- | --- | --- |
| E1 | **Recorder boot is no longer a function of the disk** (D287, stage 2). Ledger load 256.5 ms → **2.7 ms** today, 12 095 ms → **97.6 ms** at the 28 TB synthetic; boot → first locate 257.7 → **3.0 ms** / 12 133 → **101.3 ms**; wire 479.3 → **11.3 MB**; longest synchronous block 12 095 → 1.6 ms. Live hour deliberately excluded from the ledger-first path. | `recorder-index-at-scale` §6 (SHIPPED block), `togliere-i-tetti` §2 ESITO, sessions entry "the recorder's boot stopped being a function of the disk". Deployed on the hub: the `recorder: index census` lines it introduced are live in Loki from 14:16Z. | high |
| E2 | **`pipeline.progress` gated at the emit site** (D290/R1): ~**4 180 decisions/s removed** against a written prediction of 4 093–4 267; judged **per peer** — deliveries −3…−18 %, suppressions **−40…−55 %** — while total load also fell ~59 % in the window, which is why the aggregate alone could not attribute it. The only intervention today that did what it promised against a prediction recorded first. | `event-bus-fanout-load` §8 (esito misurato), deploy `addon-pipeline@1.2.146` 18:10Z. | high |
| E3 | **The event plane is ~4 % of hub-main's socket traffic.** 417 ev/s offered ×38, 0.80 wanted; suppressed offers never touch a socket (`local-child-registry.ts:616`). | `event-bus-fanout-load` §1b, counters cross-checked five-for-five against per-runner predictions (§2). | high |
| E4 | **hub-main's socket load is payload, not message rate — and one peer is the attribution.** Live tonight: `socketTx res: 21 981 msgs / 660 254 kB` in one minute (mean **30 kB**), of which **`pipeline-analytics` received 536 MB/min in 2 267 responses ≈ 236 kB each**, against 2 267 requests it made (37.8/s). The earlier window in circulation (25 714 / 379 961 kB = 14.8 kB mean; analytics 253 MB/min ≈ 133 kB each) is the same phenomenon, smaller — the flow varies with detection load. The 78–82 % `rchar` correlation of the morning is now a per-peer **attribution**. | `[mem] hub-main` line, 21:20Z tonight; `hub-main-memory-what-crosses-it` §8 SHIPPED block. | high |
| E5 | **hub-main holds ~1.5 GB genuinely live, and it is `old_space`.** Tonight's reclaim pairs read `heapUsed=1596→1518 MB`, `1616→1517`, `1638→1518` (rss 3 289→2 297 etc.); the heartbeat splits it `oldSpace=1335 MB, largeObjectSpace=153 MB`. Slightly **above** the 1 364→1 310 figure from this afternoon — the live set is growing slowly. | `[mem] reclaim` lines with the new t+0 pair (Experiment A of `recorder-heap` §11.2), tonight. | high that it is live; **zero** on what it is |
| E6 | **The recorder's stalls are `synchronous-block`, not GC.** Every `event loop stalled` line tonight (three pids, ~3 h): `stallMs` 2 007–2 623, `cause:"synchronous-block"`, `gcMs` 35–413 total, `longestGcMs` 1–35, recurring roughly 1–3×/min in steady state with `heapUsed` 1 313–1 618 MB. | `event-loop-stall-monitor.ts:87` verdict rule; Loki tonight. | high |
| E7 | **The recorder still holds ~1.2–1.25 GB with ~457–532 MB in `large_object_space`, stable, and no allocation site in the recorder's source produces a ≥131 072 B object in steady state.** Priced steady-state allocation 0.40 MB/s vs the 1.43 MB/s the refill ramp requires — **3.6× short**. Idle recorder on an agent: 52 MB. | `recorder-heap-what-is-retained` §8, §9, §11. Tonight's stall lines confirm the heap floor (1.3–1.6 GB) persists. | high on the numbers; the retainer is **not named** |
| E8 | **New tonight — a bound the corpus does not yet contain:** the recorder is **not** among hub-main's top-5 socket peers, whose smallest entry moves ~17–20 MB/min. So hub-main↔recorder wire traffic is **≤ ~0.33 MB/s**, against the 1.43 MB/s the recorder's ramp retains. Raw transport payload cannot feed the retainer unless msgpack decode amplifies ≥ 4×; the retainer is either internally generated or decode-amplified. | `socketTop` on tonight's `[mem] hub-main` lines. | medium-high (top-5 is a bound, not a census) |
| E9 | **New tonight — the frame plane is ~2 % of hub-main's syscalls.** The counters total ~63 k tx frames/min ≈ **1 050 frames/s**, against the ~22 500 write syscalls/s `/proc` measured. Bytes agree between the two instruments; **counts do not, by ~20×**. ~95 % of the 44 000 ops/s are not cap/event frames — consistent with the still-open "82 msg/s into an idle `hub/ml`" and with the Moleculer per-runner brokers as the leading candidate (`event-bus-fanout-load` §7). | Arithmetic on tonight's `socketTx`/`socketRx` vs `hub-main-memory` §4. | medium — derived, one evening's lines |
| E10 | **`hub/sqlite-settings`' native RSS has a name in source, and it breathes.** `sqlite-pragmas.ts` sets `mmap_size = min(max(1.25 × file, 256 MiB), 2 GiB)` (`sqlite-pragmas.ts:60`, `sqlite-pragmas.ts:162`) and page cache up to 256 MiB (`sqlite-pragmas.ts:187`), re-grown every 5 min (`sqlite-settings-backend.ts:1412`). The DB file is 1.12 GB → configured map ≈ 1.4 GB. Tonight the runner reads **rss 349–481 MB, heapUsed 36–40 MB** — the ~1.25 GB reading from this afternoon is a **peak** (a big pass touching the map), not a resident set. File-backed mapped pages are kernel-reclaimable. | Source read tonight; `[mem] hub/sqlite-settings` tonight; file size from `free-mnt-mixed` §2. | high on mechanism; the peak reading itself was not decomposed (one `smaps` read would close it — plan P5) |
| E11 | **Intercom was `auth:'admin'` for three months** — every non-admin refused, all cameras, all providers; fixed as the `ptz` split, plus the preset-promise guard which caught two more false promises (D289). | sessions entry 2026-08-29 (intercom). | high |
| E12 | **No steady-state memory reduction was achieved anywhere today.** Recorder floats back to ~1.3–1.6 GB (tonight's stall lines carry `heapUsedMb` 1 313–1 618); hub-main lives at ~1.5 GB heap + allocator residue against its 4 096 MB budget and crossed it once; container ~20 GiB / 32 GiB. Stage 2 changed the boot and the **rate** of the refill (15 min instead of 5), not the destination. | `togliere-i-tetti` §1 ESITO; `recorder-heap` §8.1; tonight's lines. | high |

**Corrections to the numbers in circulation** (the brief that commissioned this
checkpoint carries three that the docs contradict):

- **"Recorder boot … → 44 ms"** — no document contains 44 ms. D287's measured
  table says **2.7 ms** (ledger load) / **3.0 ms** (boot → first locate) today,
  **97.6 / 101.3 ms** at 28 TB. Quote those.
- **"The index census reads 34 KB (`rowSlots` 4 249 × 8 B)"** — that is the
  sorted-view **slot** cost only. The census' own headline number is
  `rowsAllocated` 2 032 ≈ **0.44 MB** of row objects (`recorder-heap` §7.1).
  Either way it is 0.03 % of the heap and the 60–67 MB claim is dead; use
  0.44 MB as the figure.
- **"sqlite-settings … never examined by anything today"** — examined tonight:
  E10. And the 1.25 GB is a peak, not the level.

---

## 2 · Falsified — closed too early, later disproved. Do not re-derive.

The four the day is remembered for, each with where the corpse lies:

| # | Dead hypothesis | What killed it | Where the void statements live |
| --- | --- | --- | --- |
| F1 | *The recording index is the recorder's memory* (60–67 MB, earlier 1.6 GB at 7.1 M rows) | `sortedViewCensus` live: **2 032 rows / ~0.44 MB, 0.03 %** of the heap. D287 removed the boot walk; the index holds only what the process touched. | `recorder-heap` §2 (carries its own SUPERSEDED block → §7.1); `recorder-index-at-scale` §1–§2 sizing prose — the scaling law stands, the "index = today's heap" reading does not |
| F2 | *The event-bus fan-out is hub-main's socket load* | A suppressed offer never reaches a socket; whole event plane ≈ 4 % of ops. And tonight's E9: even the *delivered* frame plane is ~2 % of the syscalls. | `hub-main-memory` §5 entry #1 (marked by its own §8/§10 and by `event-bus-fanout-load` §1b/§8) |
| F3 | *Stage 2 cut steady-state memory by ~276 MB* | Boot transient. The heap returns to the same 1.25–1.45 GB floor, in 15 minutes instead of 5. Rate changed, destination did not. | `recorder-heap` §8.1; any reading of D287's "heap retained by the load 135.3 → 2.2 MB" as a steady-state claim |
| F4 | *The recorder's 2.4–3.1 s stalls are GC* | The attribution instrument (§11.3, wired same day): every stall reads `cause:"synchronous-block"`, `gcMs` 35–413 inside 2 000–2 623 ms, `longestGcMs` ≤ 35 ms. | `recorder-heap` **§10** ("it is GC … there is no second bug") and the ANSWERED insert in its §6 — both now carry correction blocks pointing here. Note the discipline failure: §10 itself was a same-day correction that closed the question in the *wrong direction*; the §6 falsifier's second branch ("something synchronous nobody has identified") was the one that held |

And a second falsification tonight, of the day's best measurement document:

| # | Dead statement | What killed it |
| --- | --- | --- |
| F5 | `hub-main-memory` §4: *"a mean message of 327/400 bytes … arithmetically incompatible with frames, crops or GOPs dominating"*, and §6's *"no D9/D18 violation … none of them was running hot"* | §8's own named falsifier fired: the per-kind counters show the **res** plane at 30 kB mean, 660 MB/min, 81 % of it to one peer at **236 kB per response**. Media-sized payloads ARE dominating hub-main's bytes. The §4 *mechanism* (churn = traffic, live set 12–29 MB) survives; the "not media" characterisation and §6's all-clear do not. §6 is re-opened, not convicted: the shape (on-demand, compressed, by handle) is D18-legitimate — the finding is rate × size, not a forbidden path. Correction block added in that document. |

Falsified earlier in the day, already marked in the corpus, listed so nobody
walks them again: the `DurableLedger` mirror as a 100–200 MB lever (marginal
~1.5 MB, staged ceiling ~23 MB — `recorder-heap` §2/§7.4); `MfraTableStore`
(0.8–3 MB at observed uptimes, one 4.5 MB backing store at full fill — §7.3);
the playlist O(uptime) churn (607 B measured, bounded — §7.2); *"the object
trigger never fired"* (a saturated `malformed` bucket; the trigger fired —
§5 correction + sessions); *"no consumer at all"* for three event categories
(live browser consumers, missed by grep — `event-bus-fanout-load` §7a); the
27 000 dec/s figure (boot minute — §1a); `loopP50=20 ms` as chronic lag
(histogram resolution floor; shift pre-2026-08-29 series down 20 ms); and
*churn as the cause of the recorder's floor* (stage 1 removed the churn and the
floor did not move — `togliere-i-tetti` §1 ESITO).

---

## 3 · Open — with the sharpest current statement and the designated next probe

| # | Question | Sharpest statement | Next probe (named in the plan) |
| --- | --- | --- | --- |
| O1 | **What retains ~1.2–1.25 GB in the recorder** (≈ 450–530 MB LOS + ≈ 780–920 MB old space, ratio 1.75 constant → one producer) | Source audit finds no LOS allocation site in the recorder tree; priced allocators 3.6× short; wire input bounded ≤ 0.33 MB/s (E8); hunt starts **outside** the recorder tree (`@camstack/system`: runner shell, UDS transport, msgpack codec) or in decode amplification | Gated heap snapshot (now `CAMSTACK_RUNNER_HEAP_SNAPSHOT=on` + SIGUSR2), with `recorder-heap` §11.4's three attribution requirements — plan P3 |
| O2 | **What the recorder's 2.0–2.6 s synchronous block is** | Recurs 1–3×/min; scaled with heap during the boot ramp (0 → 242 → 898 → 2 627 ms as heap went 115 → 1 403 MB) yet is not the collector — the shape of *something periodically touching a heap-sized structure*. Same hunt as O1: name the structure and the block likely names itself | P3; if the snapshot names the retainer and the block persists, a 60 s V8 CPU profile (operator-armed) — plan P3b |
| O3 | **Which method carries the 236 kB responses to `pipeline-analytics`** | Leading hypothesis, unproven: native crop / keyFrame JPEG fetches by handle (`packages/addon-post-analysis/src/pipeline-analytics/runtime/native-frame-transport.ts:548` and siblings) at ~38/s — enrichment crops are native-strict by contract, and a native-tier crop is 100–400 kB | Per-method histogram on large res frames, or the existing request census — plan P1 |
| O4 | **What produces hub-main's ~44 000 syscalls/s** | Now sharper (E9): ~95 % are not cap/event frames. Candidates unchanged from `event-bus-fanout-load` §7 — Moleculer per-runner broker heartbeat/discovery (fits the idle-`ml` 82 msg/s), log ingest, transport internals | Count first, instrument second: one `strace -c -p` sample or fd-class census on the host is read-only — plan P8 |
| O5 | **hub-main's ~1.5 GB live old_space composition** | oldSpace 1 335 / LOS 153 (tonight); known structures (log ring ~15 MB, asset LRU ≤ 32 MB, load rings ~14 MB, recent-events ring) sum nowhere near it; growing slowly (E5) | Park behind P1: if the payload plane shrinks and the live set keeps growing, snapshot hub-main in a maintenance window — plan P9 |
| O6 | **The 11:23 ≥1.3 GB-in-11 s burst** | Plausibly a volley of large responses (E4 makes this likely), never attributed to a caller | The same per-method histogram (P1) names the next one |
| O7 | **Whether sqlite-settings' RSS peaks are purely mmap + page cache** | E10 names the mechanism; the peak itself was not decomposed | One `smaps` read of the `camstack.db` mapping during a peak — plan P5 |
| O8 | **`cpuGcPercent` semantics** | Reads 0 for the recorder, `null` for analytics, > total CPU for hub-main; the field is the V8Worker helper pool, and quoting it as "GC share of CPU" is not established — which retroactively weakens `recorder-index-at-scale` §1's "GC is 48.7 % of the recorder's CPU" (consistent with F4) | Do not cite it as a criterion until someone establishes what it measures (`togliere-i-tetti` §5 nota) |
| O9 | **Everything is one boot's window.** No measurement today spans a day/night cycle, a viewer session, an export or the backup window | The two hub-main regimes differ 20×, which is exactly where a daily rhythm hides | 24–48 h of the (already shipped) heartbeat; zero new code — plan P10 |
| O10 | **The writer restart storms' cause** (1 814/12 h on 2026-08-27; 59/16 min yesterday) | Per-exit `exitCode`+`stderrTail` instrumentation shipped; nobody has read it yet. May be disk-stall-driven — in which case the 30 TB array changes it | Read the lines before the array attaches, for a baseline — plan P11 |

---

## 4 · Status of the staged index plan (the operator's two claims, checked)

**Stage 3 (T2 LRU residency) — obsolete as sized, one half survives in a
cheaper form, one residual parked with a promotion condition.**

- The LRU cap and the "55–70 MB" sizing were built for an index that boot made
  whole-archive-resident. D287 removed that: the index is demand-populated
  (2 032 rows in 66 min, measured). The cap as designed has nothing to bound.
- **Residual risk, stated honestly:** nothing returns a hydrated hour to
  `unknown`, so residency is O(hours ever touched) per process lifetime —
  bounded in practice by uptime and operator activity, unbounded in principle.
  The watch already exists and is already logged: `recorder: index census`
  every 5 min. Promotion condition: sustained `rowSlots` growth toward ~10⁶
  (≈ 230 MB of rows) revives the LRU as a small follow-up.
- The "mirror sheds `paths`" half was mis-sized as a lever today (~1.5 MB
  marginal, ≤ 23 MB staged ceiling) but **scales badly**: at 8 M segments the
  staged ceiling is ~600 MB. The cheap form of that work is fixing the eviction
  read that does the staging (`oldestSegments`' missing break — plan P2), after
  which the mirror never stages more than the hours actually evicted.

**Stage 4 (retention's last whole-archive walks) — stands, and is upgraded
from a perf item to a correctness prerequisite.** Verified in source tonight:
`pruneFootage` still feeds `selectEvictions` from `deps.index.segments(deviceId)`
(`packages/addon-pipeline/src/recorder/addon/recording-provider.ts:1111`), and
`selectEvictions` copies and sorts the input twice
(`packages/addon-pipeline/src/recorder/evict-select.ts:10`,
`packages/addon-pipeline/src/recorder/evict-select.ts:50`). Post-D287 that input
is **only the resident rows** — so a policy-driven prune would silently
under-select against a demand-populated index. Today zero devices declare a
retention policy (`retention-sweep.ts` `hasRetentionPolicy`), so the defect is
latent; the moment the operator sets age policies for the 30 TB array — which
`recorder-index-at-scale` §8 itself recommends — it goes live. **Stage 4 must
land before any per-device retention policy is set.** Plan P4.

---

## 5 · 2026-08-30 — re-measured with the instruments that now exist (09:40–10:55Z pass, windows back to 08:29 22:45Z)

> **Method.** Read-only: Loki via `hl loki-query` (offsets recomputed from the
> live clock per query), source reads in this repo. No snapshot, no hub write,
> no SSH into the container, no SQLite. **Load conditions, stated up front:**
> a `recordingsLow:default → recordingsLow:ssd` drain was live through the
> whole pass (relocate jobs `cefb41c2` 06:09–10:11Z and `97809874` from
> 10:36Z, executed **inside `hub/recorder`** — the progress line is emitted at
> `packages/addon-pipeline/src/recorder/addon/index.ts:897`, and the
> coordinator in hub-main delegates to per-class movers and never carries
> bytes, `packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts:188`);
> and the hub restarted at **10:17:48Z** onto `@camstack/system` **1.2.159**
> (it ran 1.2.157 from 08-29 22:47Z until then — so everything measured
> 08:00–10:13Z today ran on 1.2.157, not 1.2.159). The restart reset hub-main's
> allocator residue: rss 8 456 → 2 748 MB.

### 5.1 What each supersession in this section replaces

| Marks | Status after today |
| --- | --- |
| E4 (the 236 kB responses to `pipeline-analytics`) | **superseded by §5.3** — attribution found, and it is not media |
| E5 / O5 (hub-main live set 1.5 GB) | numbers updated (§5.4); still not named |
| E7 / O1 (recorder LOS ~490 MB, ratio 1.75, "retained set") | **partially superseded by §5.2** — floor confirmed, ratio falsified, "retained" re-framed by the t+0 pairs |
| E8 (recorder↔hub-main wire ≤0.33 MB/s) | strengthened: measured directly today at ~0.04 MB/s (§5.2) |
| O2 (the 2.0–2.6 s synchronous block) | **materially narrowed by §5.2** — collapsed from ~60–80/h to ~1/h at the 08-29 20:36–21:45Z boundary |
| `hub-main-memory` §3 ("arrayBuffers is never a set, always 12–29 MB after GC") | **falsified as a universal by §5.5** — a 4.5 GB retained episode survived six compactions today |
| F5's re-opened D9/D18 question | closed for the analytics flow (§5.3): the payload is the settings plane, not media |

### 5.2 Recorder: the shipped changes did NOT remove the large_object_space — but the stall is (almost) gone and the "retained set" story changed

**LOS floor unchanged.** pid 1533278 (07:44–10:14Z, 31 five-minute samples):
`heapUsed` 1 245–1 824 MB, `oldSpace` 772–1 182, `largeObjectSpace` 457–593 with
floor **458–462 MB** — the same 457–532 band as the checkpoint. D287 was already
live at the checkpoint; D295, the eviction fix and pipeline 1.2.151 landed since,
and the floor did not move. **The shipped changes did not touch the retainer.**

**The 1.75 ratio is dead.** Under drain load the two boots of 10:13–10:38Z read
`oldSpace:LOS` = 741:705 (**1.05**) and 102:619 (**1.00**), against 1.65–1.99 on
the long-lived pid. §8.2 of `recorder-heap-what-is-retained` inferred "one
producer" from a constant ratio; the constant does not survive a load change, so
the one-producer inference is weakened — or the drain adds a second, LOS-heavy
allocation stream. (Load-following is itself information: the LOS content grows
with relocate work.)

**The t+0 pairs re-frame "retained".** Five reclaim lines now carry
`heapUsed=<before>→<after>` (`packages/system/src/kernel/heap-watch.ts:1061`):

```
08-29 23:00:46  747→ 739 MB     08-30 05:31:48  1373→1245 MB
08-29 23:07:20 1591→1397 MB     08-30 05:46:05  1221→1207 MB
08-29 23:09:20 1420→1394 MB
```

The post-compaction live set is **739–1 397 MB and moves 650 MB in seven
minutes** (23:00 → 23:07). So the ~1.3 GB floor is not a fixed resident
structure: at least ~650 MB of it is material with **minutes-scale lifetime**,
re-created continuously. `recorder-heap` §1.2's "the live set is ≥ ~1.37 GB"
was true of its moment, not of the process. O1's hunt must now match three
properties at once: ≥128 KB objects, minutes lifetime, volume that follows
recording/relocate load. (Confidence: high — direct t+0 measurements.)

**The allocation-budget gap widened.** The eviction fix is confirmed live:
every `eviction round complete` in 26 h has `rows == removed` (typical 4–66
rows, 252–6 663 ms; the only four rounds ≥1 000 rows are 1 003–1 303, all fully
removed). That removed ~270 KB/s — two-thirds of everything §9 of
`recorder-heap` could price — yet the boot ramp is unchanged or faster: pid 327
went 119 → **1 473 MB in ≤ 5 minutes** (10:17:48 → 10:22:50Z, under drain).
Priced allocators are now **≥ 10× short** of the ramp. The dominant allocator
was never on the priced list, reinforcing O1's "start outside the recorder
tree".

**O2: the 2.0–2.6 s stall collapsed, and the residual is GC-free.** Hourly
stall counts: ~60–82/h from 17:39 to 20:36Z on 08-29, then **1–3/h** from
21:45Z onward through all of today. The collapse sits exactly at the
20:36–21:45Z boundary — the restart that brought the 1.2.156-era build with the
eviction fix — so the dense stall was, on timing evidence, **the eviction page
walk** (6 240 rows built per round, 7 rounds/min). Not proof; but the fix
shipped, the walk stopped, and the stall stopped, in the same process lifetime.
The residual ~1/h stall is pure synchronous block: today's example reads
`stallMs=2578, gcMs=0, gcCount=0, heapUsedMb=1386`
(`event-loop-stall-monitor.ts:87` verdict). O2 stays open only for this
residual. `loopMax` per 5-min window fell from 2 471–3 128 ms (checkpoint) to
**296–1 561 ms** typical today.

**Bounds re-verified today:** recorder↔hub-main wire = 2.35 MB/min tx +
0.75 MB/min rx (`socketTop` 09:10Z line) ≈ **0.04 MB/s** — E8's bound tightened
8×; agent-recorder control 52–56 MB heap, unchanged; index census at 12.9 h
uptime: `rowSlots` 48 542, `sortedViews` 30, `rowsAllocated` 2 226 ≈ **< 1 MB**,
growing roughly linearly with uptime, 20× below the ~10⁶ promotion condition.

### 5.3 hub-main: the "236 kB responses to pipeline-analytics" are the settings plane, relayed — not media (supersedes E4's open question, answers O3 in the main)

`socketTop` byte-conservation across single minutes names the flow. In matched
minutes, what hub-main **receives from `hub/sqlite-settings`** equals what it
**sends to `hub/pipeline-analytics`**, at a ~2:1 request fold:

| minute (Z) | sqlite→hub-main | hub-main→analytics | sqlite res/min | analytics res/min |
| --- | --- | --- | --- | --- |
| 10:40 | **618 311 kB** | **609 848 kB** (Δ 1.4 %) | 11 236 (≈55 kB ea) | 5 684 (≈107 kB ea) |
| 10:39 | 296 450 kB | 302 579 kB (Δ 2 %) | 9 808 | 5 474 |
| 10:34 | 287 839 kB | 375 587 kB | 8 898 | 5 583 |

Analytics asks hub-main, hub-main issues roughly two settings-store queries per
request, and relays the rows back: **the 40–135 kB mean response is a page of
`pipeline-analytics:*` rows** (that store's own biggest tables are
`pipeline-analytics:media` 296 MB and `:tracks` 143 MB per the sqlite storage
report of 10:18:50Z). It is not the by-handle media path: recorder→hub-main is
0.75 MB/min, and stream-broker's steady 86–94 MB/min into hub-main is fully
accounted for by the symmetric **frame relay to `pipeline-orchestrator`**
(orchestrator makes 7 600–9 200 req/min and receives 89–96 MB/min back ≈
10.5 kB/frame ≈ 140–150 frames/s — the D9/D18-legitimate compressed frame
plane). **F5's re-opened D9/D18 question closes for this flow: no media
violation; the finding is that the settings plane crosses hub-main twice and
nobody bounds its result pages.** Corroborating instrument: `settings-store
query truncated by a defensive row cap` fires 119×/30 min, every one
`collection=addon-device-settings, rowCap=2000, requestedLimit=null` — full
2 000-row pages being pulled 4×/min by an unnamed caller with no limit.
(Confidence: high for the matched-minute attribution; the caller and method
name still need the per-method histogram, plan P1.)

**Not attributed:** burst minutes where the analytics flow does NOT come from
sqlite-settings — 08:58Z: 728 MB out vs 12.8 MB in; 09:09Z: 771 MB out vs
9.7 MB in. Visible top-5 rx in those minutes totals ~219 MB; the other 33 peers
are each bounded by the smallest top-5 entry (~16 MB/min), which caps hidden rx
at ~530 MB — arithmetically enough, so "originates inside hub-main" cannot be
concluded. Source undetermined. Mean response today is 64–135 kB against the
checkpoint's 236 kB; the flow's mix, not its nature, changed.

### 5.4 hub-main: the live set grew, and today's numbers (updates E5/O5)

Post-restart (10:30–10:41Z, system 1.2.159): `heapUsed` 1 657–1 853 MB,
`oldSpace` 1 448–1 618, `largeObjectSpace` **140**, reclaim t+0 floor
**1 281–1 598 MB**. Pre-restart on 1.2.157 (07:30–10:13Z): post-reclaim floor
1 570–1 802 MB, `heapUsed` to 2 140. Checkpoint values were 1 517–1 518
post-reclaim. The genuinely-live set has grown ~50–280 MB in a day and remains
unnamed (O5 open). New reclaim behavior observed: after 6 floor-passes the
reclaim **backs off to 600 s** and says so — hub-main now reclaims 6×/h, not
30×/h. O4 unchanged: `socketTx` totals ≈ 65–75 k frames/min ≈ 1 100–1 250/s
against ~22 500 writes/s — the ~20× count gap stands; per-peer counters cannot
close it, only the fd-level census can (plan P8).

### 5.5 NEW — a retained-ArrayBuffer episode: 4.5 GB held for 70 minutes through six compactions (falsifies `hub-main-memory` §3 as a universal)

08:13–09:27Z today, on 1.2.157, hub-main's `arrayBuffers` climbed
monotonically: 48 → 936 (08:34) → 2 047 (08:48) → 3 004 (09:04) → 4 004
(09:18) → **4 513 MB** (09:26:56). Six forced compactions ran inside the ramp
and the POST-GC values kept rising — 755, 1 416, 2 033, 2 630, 3 265,
3 914 MB — so this was **live, reachable Buffer memory, not sweep debt**. rss
peaked at 8 960 MB (budget 4 096). At **09:27:58Z the whole set released in
one instant** — 4 513 → 339 MB between consecutive heartbeats, with no reclaim
in that minute and no matching log line found.

What it correlates with, honestly: relocate job `cefb41c2` moved +2.92 GB in
08:34–09:26 against the ramp's +3.58 GB in the same span, and the ramp's
~60 MB/min slope sits in the job's 40–90 MB/min byte-rate band. But the
relocate executes inside `hub/recorder` (file I/O, not sockets), the current
job `97809874` at ~22 MB/min produces **no ramp** (arrayBuffers 39–315 MB
churn, 10:38–10:51Z), no data-plane serves occurred in the window (3 total),
and no `socketTop` flow grows with the ramp. **Mechanism unidentified.**
Candidates, in order: a socket write-queue to a peer that stopped reading
(release = the peer draining or the socket dying), a queue inside a hub-main
facility, or a byte-path of the migration coordinator not visible in source
reading. Cheapest probe that would name the next one: per-peer
`socket.writableLength` (queue depth) next to the existing counters in
`packages/system/src/kernel/socket-plane-report.ts:305` — a retained set of
socket-queued Buffers is invisible to every instrument that exists today.
(Confidence the episode is real and live: high — reclaim pairs are direct
measurements. Attribution confidence: none.)

### 5.6 Ranked — what remains, by bytes, with the arithmetic

| # | Unknown | Bytes | Arithmetic | Confidence it exists / that it is named |
| --- | --- | --- | --- | --- |
| 1 | hub-main retained-Buffer episodes (§5.5) | **up to 4.5 GB**, episodic | reclaim pairs 755→3 914 MB post-GC across 6 passes | high / **not named** |
| 2 | Recorder heap floor (O1) | **0.74–1.4 GB**, of which LOS 458–593 MB | t+0 pairs + per-space heartbeat | high / not named; now known to be minutes-lived and load-following |
| 3 | hub-main live old_space (O5) | ~1.45–1.62 GB, growing ~50–280 MB/day | reclaim t+0 floor 1 281→1 802 across the day | high / not named |
| 4 | Settings-plane relay cost (§5.3) | 100–620 MB/min through hub-main, ×2 (in+out) | socketTop matched minutes | high / **named**; unbounded pages are the fix surface |
| 5 | Analytics burst minutes (§5.3) | ~700–770 MB/min, minutes-long | 08:58/09:09Z lines | high / not named (top-5 bound too loose) |
| 6 | O4 syscall gap | ~95 % of 44 k ops/s, byte-light | 1 100–1 250 frames/s counted vs 22 500 writes/s | high / not named |
| 7 | Residual recorder stall | ~1/h, 2.0–2.6 s, gcMs=0 | stall lines since 08-29 21:45Z | high / not named |

### 5.7 What still requires a snapshot, precisely

- **O1 (recorder).** The per-space split, the census, the t+0 pairs and the
  eviction fix have priced or killed every in-tree candidate; no further Loki
  reading can name the LOS producer. The snapshot must show: (1) the live
  objects ≥131 072 B grouped by type **with the owning class field** (§11.4 of
  `recorder-heap`), and — new after today — (2) an owner whose contents
  **turn over in minutes and scale with relocate/recording load**. A snapshot
  during the drain and one at night would differ by the load-following share.
  Without it, the only cheaper move left is allocation sampling
  (`v8.setHeapSnapshotNearHeapLimit` is not it; a sampling heap profiler over
  60 s is), which is a deploy, not a read.
- **§5.5 (hub-main episode).** A snapshot **during an episode** would name the
  Buffer retainer in one read. Outside an episode it answers nothing. The
  `writableLength` counter is the non-snapshot instrument, and it also arms the
  next episode with a per-peer name in the log.
- **O5 (hub-main old_space)** still parks behind P1/P9 — nothing today changed
  that.
- **NOT needing a snapshot:** the §5.3 caller (per-method histogram, P1), the
  O4 census (fd-level, P8), the `addon-device-settings` no-limit caller (grep +
  one log field), the residual stall (60 s CPU profile, P3b).
