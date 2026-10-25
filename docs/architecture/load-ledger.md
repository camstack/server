---
title: Load ledger — what this system costs, what it is proportional to, and every time it went wrong
covers:
  - packages/system/src/builtins/native-metrics/node-load-ring.ts
  - packages/system/src/builtins/native-metrics/load-series-config.ts
  - packages/system/src/builtins/native-metrics/load-series-reader.ts
  - packages/system/src/builtins/native-metrics/cgroup-memory.ts
  - scripts/check-cgroup-path-single-owner.ts
  - scripts/measure-load-series-cost.mts
  - packages/system/src/kernel/heap-watch.ts
  - server/backend/src/core/addon/device-meta-mirror.ts
  - packages/addon-pipeline/src/recorder/addon/segment-writer.ts
  - packages/addon-pipeline/src/recorder/addon/redundancy-sweep.ts
  - packages/addon-pipeline/src/recorder/redundant-segments.ts
  - packages/types/src/capabilities/load-contribution.cap.ts
  - packages/types/src/process/child-cost-registry.ts
  - packages/addon-admin-ui/src/components/cluster/load/camera-load-fold.ts
  - packages/addon-admin-ui/src/components/cluster/load/camera-load-rates.ts
  - packages/addon-admin-ui/src/components/cluster/load/contribution-origin.ts
  - packages/addon-admin-ui/src/components/cluster/load/use-camera-load-series.ts
  - packages/addon-admin-ui/src/components/cluster/load/CameraLoadPanel.tsx
  - packages/types/src/metrics/load-series-fold.ts
  - server/backend/src/api/core/load-contributions.ts
---

# Load ledger

A register of **load** problems — CPU, RAM, I/O — with the measurement that
identified them and the one that proved the fix.

It exists because on 2026-08-27 every single measurement was redone from scratch: the
per-process breakdown, the garbage-collection share, the cost per event,
the count of rows read. None was written down anywhere, and without the
**starting** number a fix cannot be declared successful.

## The rule

**A load is declared resolved only with the before and after measurement, and
that measurement is written here.** An optimisation without the starting number is
an opinion.

And the assertion that protects it in the code checks **what is asked** — one
query instead of N, one sum instead of a scan — **never the result**. An identical
result is precisely what allowed three different defects, on this single day,
to survive for months against a green suite.

## The invariant: what it MUST be proportional to

The question that unmasks a load defect is not *"how much does it consume"*, it is
**"what does it grow with?"**.

| Component | Must grow with | Is a DEFECT if it grows with |
| --- | --- | --- |
| `stream-broker` | frames, bitrate, **live** sessions | the number of cameras regardless of viewers |
| `pipeline-analytics` | **useful** detections | frames, or discarded events |
| `recorder` | segments written | the archive rows already indexed |
| `hub-main` | calls served | the fleet's devices |
| providers (reolink, hikvision, …) | events **handled** | events received and thrown away |

A load proportional to the number of **devices** in an installation of thirty
cameras is almost always an `N+1` in disguise.

## Register

### 2026-08-27 — the day of the four wrong diagnoses

Initial symptom: slow previews in the app, then 692% CPU and 19.35 GiB out of 32.

**Context to remember**, because it decided the interpretation of all the
rest: at 14:57 the **host's global** OOM killer (not the cgroup) killed
`hub/pipeline-analytics` at **11.4 GB** of anon-rss. Every hub runner
recorded at the same instant `loopMax ≈ 152–158 s`: **a block of ~154
seconds of the whole container**, which is also why the Reolink watchdogs
restarted the streams. CamStack was at 19 GB against **its** limit of 32: it did not
overrun anything — the machine's RAM ran out, shared with the reference NVR (561%
CPU, 10.5 GB). **Raising CamStack's limit does not help; lowering its
consumption helps both.**

**The rewriting of the problem**: separating the `MainThread` threads from the `V8Worker`s,
**~2 whole cores of the container are not computing — they are collecting garbage**.

| process | main | GC | total | GC share |
| --- | --- | --- | --- | --- |
| hub-main | 50.2% | **138.4%** | 188.7% | **73%** |
| `hub/stream-broker` | 38.7% | **61.3%** | 100.0% | 61% |
| `provider-hikvision` | 6.2% | 6.8% | 13.0% | 52% |
| `hub/recorder` | 9.4% | 0.0% | 9.5% | 0% |

| # | Defect | Measurement before | After | Status |
| --- | --- | --- | --- | --- |
| 1 | **Frame retrieval for an always-empty array.** `embedding-dispatcher` retrieved a whole cross-process frame + 2 copies for **every** detection, to iterate `analysisResults`, which the only emitter fills with a literal `[]`. Profile: `external=4264MB` against `heapUsed=536MB` — **96% of the growth was never V8 heap** | ~1.4 MB/event @640; **~28 MB × 2** on `keyFrame` 4096. 50 empty events ⇒ 50 retrievals | 0 retrievals | ✅ shipped |
| 2 | **Hikvision alarm flood.** `videoloss/inactive` is the firmware heartbeat, repeated every ~5 s. Logged at the same level as `videoloss/active`, which is a **real signal loss** | **83,198 lines / 12 h** on 20 cameras. Underneath, **2** real alarms (`io/active`, dev 3839) | 2,880 / 12 h (**−96.5%**), count per `(type,state)` | ✅ shipped |
| 3 | **The metadata mirror re-read the whole fleet on every device event.** It had a guard that limited **concurrency**, not **frequency**: when a round finished another started immediately | **4,904 calls / 4,987,368 rows** in 120 s. 4,987,368 ÷ 4,904 = **1,017.0** — the entire fleet, every time | ~2,000 rows (**~2,400×**) | ✅ shipped (1.2.201) |
| 4 | **`getChildren` per device.** It was not a loop: `getAccessoryChildren()` **always** exists and answers `[]`, so every leaf paid a round trip to discover it had no children | **1,024 RPCs** at boot | **4** (self-paced collector, batches of 256) | ✅ shipped (1.2.201) |
| 5 | **Pre-roll RTP rings.** 10 s by default on every broker, and every `high` is **hot forever** because of synthetic demand | 47 rings for 13 cameras, **898 MB** of arrayBuffers | — | ⚠️ product choice; **a fleet budget is missing** |
| 6 | **The recorder index kept fully hydrated** by a 2×/min pressure sweep that sums every row and makes a **sorted copy** of it | **1,606 MB** of JS heap ≈ **7.1 M rows** (~30 d) | boot SUMMARY, not full hydrate ([D287](../decisions/adr-0287-hydrated-means-resident-and-boot-loads-the-summary-not-the-archive.md), 29/08) | ✅ stage 2; T2 LRU + P12 remain |
| 7 | **The segment writer restarts, and the reason is thrown away.** `exitCode` and stderr are captured and printed only on give-up; for `reason=exit` **there is no line**. `STABLE_RUN_MS=30_000` resets the counter, so the storm is **invisible to the controller** and can last forever | **1,814 restarts / 12 h** = 2.5/min, each rewrites ~10 s of media already on disk. Measured `ranMs`: 122,620 / 165,255 / 345,420 / 394,522 ms — **all above 30 s**, hence `attempt` = 1 on 1,814 lines and `onGaveUp` **0 times** | every exit prints `exitCode`+`signal`+`stderrTail`+`ranMs`; a sliding window of **15 restarts/h** that a long run cannot reset; the duplicate pruner **rewired** | ✅ diagnostics; 🔧 ffmpeg cause + duplicate at respawn |
| 8 | **The memory guardian cannot see the Buffers.** `stranded = rss − heapUsed − external`: `external` is **subtracted by construction** | let **11.4 GB** pass without a warning | RSS budget declared per process; 4 processes watched, the others **declare themselves unwatched** | ✅ see A1 |

### A1 — 2026-08-27 — the watch looks at `rss` against a declared budget

**Before.** The only threshold on overall consumption was `shouldReclaim`, built
on `strandedMb = rss − heapUsed − external`. On growth that sits **entirely in
`external`** that number is **algebraically constant**: minuend and subtrahend
move together. Starting measurement, `hub/pipeline-analytics` shortly before
dying:

| | rss | heapUsed | external | arrayBuffers | stranded |
| --- | --- | --- | --- | --- | --- |
| rising | 5,735 MB | 536 MB | 4,264 MB | 2,315 MB | **935 MB** |
| at 200 MB of `external` | 700 MB | 536 MB | 200 MB | 108 MB | **935 MB** |

`rss` ×8, `stranded` unchanged and **below** the 1,024 MB trigger the whole
time: no threshold on that number could fire. `--max-old-space-size=1024`
was in force and correctly bounded a 536 MB heap. **Warnings emitted: zero**,
until the global OOM killer at 11.4 GB and the ~154 s container block.

**After.** A threshold on `rss` against a **budget declared per process**, with
the breakdown on the line. On the same sample:

```
[mem] hub/pipeline-analytics OVER RSS BUDGET rss=5735MB budget=2048MB over=+3687MB
  shape=external heapUsed=536MB(9%) external=4264MB(74%) nativeResidue=935MB(16%)
  arrayBuffers=2315MB budgetFrom="manifest execution.rssBudgetMb"
  — Buffers / native external — NO V8 flag bounds this, and the old-space ceiling never will
```

The three shares **are** the diagnosis: 9 / 74 / 16 names the shape and therefore the lever,
among the three that `smaps` found the same day (`v8-heap` on the recorder,
`external` on the stream-broker, `native-residue` on hub-main).

**Where the budget lives, and why.** In the addon's manifest
(`execution.rssBudgetMb`), next to `maxOldSpaceMb` and for the same reason: the
legitimate footprint depends on the **role** and varies by an order of magnitude
(recorder 1.5 GB of live V8 index = correct; analytics 1.5 GB = not). A
single constant would either absolve analytics' 11 GB or accuse the recorder's
legitimate 2 GB. The runner takes the **maximum** among the co-located addons
(D2/D29). hub-main has no manifest and its entrypoint is the **least
deployable** surface of the system — the image never contains this repo's
backend — so its number lives in `@camstack/server`, which `applyServerUpdate`
replaces within the day.

| process | budget | from what | prediction |
| --- | --- | --- | --- |
| `hub-main` | 4,096 MB | ceiling 3,072 + measured native floor 438 MB | **will fire**: measured at 4.87 GiB, with 2.8 GB of native memory not returned |
| `hub/recorder` | 3,103 MB | 1,509.8 MB in V8 pages, `brk` 53.9 MB, `external` 8 MB | stays within |
| `hub/stream-broker` | 2,048 MB | RSS peak 1,585 MB; 1,159.1 MB of `brk`, old space 224 MB | stays within |
| `hub/pipeline-analytics` | 2,048 MB | no legitimate multi-GB working set | 5.5× below the number that killed the host |

**No class default.** A process without a declaration is **not
watched and says so** once at startup (`is NOT WATCHED against an RSS
budget`). Inventing a number for a never-profiled process would be the same
defect in a new place. The measurements exist for four processes: four
processes have a budget.

#### A1b — 2026-08-27, second pass: the uncovered runners get measured

The four declarations above left **eight runners unwatched**. New `[mem]` samples taken the same day **with two cameras open in
live view** — therefore an active load, not an idle one — cover them:

| runner | rss | heapUsed | external | budget | why that number |
| --- | --- | --- | --- | --- | --- |
| `sqlite-settings` | 656 MB | 115 (18%) | 13 | **1,536 MB** | ~528 MB are neither V8 heap nor `external`: they are the native pages of `better-sqlite3` (page cache, mmap, statement arenas) — the `native-residue` shape, which is a high-water mark and is not returned. 1,536 leaves room for **one** big pass (migration, backup, vector query) above today's floor. Beyond 1.5 GB, for a settings archive, is not legitimate work |
| `detection` | 553 MB | 121 (22%) | 14 | **1,536 MB** | the group exists so that frames do **not** cross a process boundary (D9/D18): decoded frames and detector weights are its legitimate working set. The 627 MB peak (25-08, 6 h) already includes a resident model; 1,536 covers a second engine or a larger input — the **step** in which this runner really moves — and bites 7.4× below the 11.4 GB. 2,048 would put it on a par with the stream-broker, which parks ~1 GB of RTP rings: an unreachable budget, hence never a warning |
| `provider-reolink` | 472 MB | 155 (33%) | 34 | **1,024 MB** | the invariant says a provider grows with the **events handled**, never with the fleet. 1,024 covers a doubling of the handled load and **stops there on purpose**: a provider that doubles while the fleet does not is exactly the `N+1` this register exists to catch. A wider budget would absolve precisely that defect |
| `snapshot` | 360 MB | 112 (31%) | 19 | **1,024 MB** | it holds JPEG buffers, but one per request and for a short time (`external` at 19 MB confirms it does not park). The peak case is a fan-out (a grid, a pass of thumbnails), bounded by concurrency and not by the fleet. At a gigabyte, the buffers are outliving the response |
| `ml` | 267 MB | 193 (**72%**) | 6 | **2,048 MB** | 72% heap and 6 MB of `external` say the sample caught the group **with nothing loaded**. Sizing it on 267 MB would guarantee a false alarm on the first opening of Model Studio. The number must be taken from the **loaded** case: `model-studio` and `benchmark` pull weights and evaluation batches into `external`, hundreds of MB per session. Declared on `model-studio`, the member whose role knows the number; `ai` and `benchmark` are covered by the group maximum |
| `decoder-nodeav` | 244 MB | 96 (39%) | 6 | **1,536 MB** | same story, different step: `external` at 6 MB says it was **not decoding**. The legitimate footprint is frames in flight × resolution × sessions: a 4K context with its references is tens of MB, a grid of 4K is a few hundred. Tighter would cry wolf on the first opening of six 4K streams — and a guardian that cries wolf gets silenced |
| `audio-analyzer` | 176 MB | 105 (60%) | 13 | **512 MB** | audio and nothing else. One second of mono 16-bit PCM at 16 kHz is 32 KB: even a generous ring per camera across the whole fleet fits in single-digit MB. **This number must stay small or it means nothing**: a frame-shaped budget would make it unwatched in practice. 2.1× the observed peak, and still an absurd amount for measuring levels |

**The multiplier is not taste.** It comes from how far the sample is from the
**loaded** state of the role, and it is the **shares** that say so — the same reading that
the module makes on the alarm line. A sample with real `external` or native residue
(`working`) = it caught the process while working, little margin is needed, and
the guardian keeps it **within 3×**. A sample almost all V8 heap with `external`
at a single digit (`idle`) = it caught it standing still, and the ratio against that number
means nothing: `ml` and `decoder-nodeav` are sized by role, not by the
sample, and are excluded from the 3× constraint **with that reason written in the
test**.

**`pipeline-analytics` was not uncovered**, contrary to how it seemed:
it already declares 2,048 (A1). Today it measures 1,218 MB — but the shares have changed,
15% heap / 3% `external` / **82% native residue**, whereas the sample that
killed it was 74% `external` with 2,315 MB of `arrayBuffers`. Removing the dead
frame retrieval **fixed the growth in `external`**; what remains
is glibc high-water from the same traffic, not live Buffers. 2,048 stays right:
1.68× today's number, and it would have fired at 5,735 MB.

**One remains uncovered and has a name.** `pipeline-orchestrator`, measured 385 MB
in the same pass: its package was in the hands of another in-flight change
when these seven were declared. 1,024 MB is the number its sample supports. The guardian (`scripts/__tests__/rss-budgets.spec.ts`)
**names it explicitly** and will fail the day it gets declared — which is the
reminder to delete the line, not to widen it.

**What the guardian proves, and what it does not.** Every declared budget is passed
through the **real** `startHeapWatch` at one MB above and one MB below: above it must
produce `OVER RSS BUDGET` with that budget, below it must stay silent. Disarming the
comparison in `heap-watch` (`rssMb > budgetMb` → `'within'`) the nine firing assertions
turn red and those on the manifests stay green — i.e. they measure
the alarm, not the JSON. The **maximum among co-located** stays proven by the fixture case
in `addon-runner.spec.ts` (512 vs 3,103 → 3,103, red if `Math.max`
becomes `Math.min`): **no group that ships today has two members that
declare different numbers**, so the real manifests cannot tell max
from min. What the real manifests prove is the complementary half — the
`ml` group, with two silent members, stays watched by the one that speaks.

**Noise.** One line on the **state change**, never one per sample — the probe
runs every 2 s, so the level would produce 30 lines/minute on a process
legitimately large, which is exactly how the 83,198 Hikvision heartbeats
buried two real alarms. Hysteresis at 90% of the budget (a 1 MB return is not
a return) plus a minimum of 15 minutes between two announcements, because the reclaim
pass can move hub-main by ~1.6 GB every 2 minutes: a process that oscillates
across the budget is **one** story, not thirty an hour.

**Idle cost: nil.** No new timer, no new syscall. The
check reuses the `HeapSample` that the probe already builds at every beat: six
comparisons between numbers and no allocation: the string exists only on the
transition. `strandedMb` stays, unchanged, as the **reclaim gate** — it answers
correctly that question ("are there pages a last-resort GC can return?");
it could not answer "this process is too big".

**The 2.8 GB of hub-main beyond the heap ceiling** — with `--max-old-space-size=3072`
and an RSS of 4.87 GiB — **are not JS heap and are not live Buffers** (`external` was
360 MB). They are **native memory already freed that the allocator does not return to the
kernel**, the high-water residue of the traffic transiting the router.
Demonstrated three times: a constant floor within **4 MB** over five consecutive
`gc(last-resort)` (4,559 / 4,561 / 4,560 / 4,562 / 4,563 MB); a
map in which **99.2%** is private dirty anonymous with only 1,295 MB in V8
pages; and the comparison with the runners, which shows **three distinct shapes** (stream-broker
has the Buffers in the glibc heap, the recorder is all V8, hub-main is large
mappings that neither V8 nor the `external` accounting knows about).
`MALLOC_ARENA_MAX=2` **is already applied**: that lever is spent.

#### 7 in detail — the writer storm, before and after

**Before.** `count_over_time` over 12 h: **1,814** `SegmentWriter restarting`, all
`reason=exit`. Breakdown per writer, which is the datum that decides everything:

| writer | restarts / 12 h | /h |
| --- | --- | --- |
| `1441/high` | 549 | **45.8** |
| `101/high` | 241 | 20.1 |
| `618/high` | 217 | 18.1 |
| `592/high` | 211 | 17.6 |
| `104/high` | 195 | 16.3 |
| `3839/high` | 133 | 11.1 |
| `586/high` | 116 | 9.7 |
| `102/high` | 95 | 7.9 |
| **every `low` profile** | **4–15** | **≤ 1.3** |

The `low` profile — same writer, same ffmpeg, same disk — is **healthy**. It is the
`native:main` shared with detection and viewers that restarts, and every restart is
preceded by the broker logging `RTSP client disconnected … total: 0` on the
same stream (101: disconnection 16:40:51 → restart 16:41:17; 16:43:49 →
16:44:03). **Correlation, not cause**: no line said why ffmpeg
exited, and that is exactly the defect.

**After** (three changes that go together, or the second is not formulable):

1. `SegmentWriter ffmpeg exited` — `exitCode`, `signal`, `ranMs`,
   `restartsInWindow` and the stderr tail, with `tags: { deviceId }`. The datum was
   already in the caller's hands and was discarded 1,814 times.
2. A **sliding window** (`RESTART_WINDOW_MS` 1 h, budget **15**) that counts
   every restart **regardless of `ranMs`**, modelled on `CrashSupervisor`
   (D6). The budget separates the eight storms measured above from the healthy `low` profiles, and
   does not overshadow `MAX_RESTARTS`: 10 consecutive rapid failures remain faster
   than 15 in an hour. On exceeding it the writer stops respawning and calls
   `onGaveUp`, i.e. finally `recoverWriterGaveUp` — which re-composes the dial with the
   broker instead of relaunching ffmpeg on the same url that keeps ending.
3. The **duplicate pruner exists again**. Verified: `janitor.ts` and
   `redundant-segments.ts` had been deleted along with the
   dead walk that was their only caller, and since that commit
   **no line of code removed a duplicate**. `selectRedundantSegments`
   is back unchanged; the pass is `RedundancySweeper`, hourly, and reads a
   **window** (`segmentsStartingIn`, 2 h lookback) instead of the archive —
   the old form copied and re-sorted every row of the camera, ~560 MB of transient
   heap at 7.1 M rows, i.e. the cost that #3 of this same day
   had just removed.

**What this does NOT do**, and it must be written: it does not eliminate the *cause* of ffmpeg's
exits — today nobody knows it, and point 1 is the prerequisite for
knowing it. And it does not prevent the **writing** of the duplicate: the 10 s pre-roll
is still served at every re-dial and still rewritten; it is only pruned afterwards.
Closing that at birth (no pre-roll on a *respawn*, which
has no new trigger in front of it) is the next item, and must be measured first.
### 2026-08-27 (evening) — the GC share becomes a product datum

The breakdown in the table above had been obtained by hand via SSH: there was
no line of code that read `/proc/<pid>/task/*/stat`, and therefore
no way to redo the measurement without redoing the work. Now it exists, on the tick
that the process-snapshot was already paying for — and **no new sampling
was added on any node**: the Load page consumes a fan-out that already existed
(D250). At the time there was no historical series retained
anywhere and the window was the time the page stayed open — **the following
entry changes this**, in memory and with a measured ceiling (D251).

In the same session it emerged that `coarsenProcessList` deduplicated on `state`
and `memoryRss` — names from `$process.list`, not from the shape it receives — so
**the memory bucket never worked**. The docblock described the right
design and the code did not do it.

### 2026-08-27 (evening) — a new ring, and its cost measured BEFORE

This entry is the opposite of all the others: it does not record a load found,
it records a load **added**. The Load charts window lived in the browser
tab — close the page and the hour is gone, and two operators on the
same node saw two different charts of the same event. Now
`native-metrics` keeps the last **180 snapshots per node** in a partitioned
in-memory ring (D251). No new sampling: it subscribes to the
fan-out that `metrics.node-processes-snapshot` produces anyway every 20 s (D250).

**The measurement, and how it was done.** No estimate. **Real** cluster payloads,
read read-only from `metricsProvider.listNodeProcesses` on the three
nodes — `hub` **42** processes, `MacMiniAgent.localdomain` **20**,
`agent-a` **14** = **76 rows** — brought to the current shape of the
schema (`cpuMainPercent` / `cpuGcPercent` / `threadCount`, which the production
hub does not yet emit), re-parsed **fresh at every sample** (in
production every snapshot arrives with its own strings; sharing them would have
underestimated) and weighed as **retained** V8 heap after `--expose-gc` with six forced
GCs before and after.

| | value |
| --- | --- |
| process rows retained (3 nodes × 180 × 76) | **13,680** |
| retained heap | **6,348,912 B = 6.06 MiB** |
| **per process row** | **464.1 B** |
| per sample (one node snapshot row) | 11.76 kB |
| `external` | **+40 B** — no Buffers, all V8 |

Linearity verified at 360 samples: 12.105 MiB, **463.9 B/row**. The count is
proportional to the **rows**, not to the samples — and that is why the fleet
ceiling is denominated in rows.

**The two ceilings.**

| ceiling | value | why |
| --- | --- | --- |
| per node | **180 samples** (hard) | the operator's hour, at a 20 s cadence |
| fleet | **32,000 rows ≈ 14.2 MiB** | 2.3× the hour of the whole live cluster (13,680), so no real installation evicts; and it is the same order of magnitude that hub-main has already accepted for the log ring (50,000 × ~306 B ≈ 15 MB) |
| partitions | 16 | bounded key space, like `DEFAULT_MAX_LOG_BUCKETS` |

The per-node ceiling **is not** a memory limit: 180 samples of a node that
multiplies its own processes grow without bound. It is exactly defect #5
of this same page — maximum per instance, no fleet budget. When
the budget bites, the **oldest sample of the heaviest partition** is discarded:
the node that generates the pressure pays, and a quiet node keeps
its whole hour.

**Eviction.** A partition whose most recent sample is more than **an hour** old
(= 180 × 20 s, the whole representable window) is dropped whole.
Not "on node removal": a node that is simply offline is never
removed, so the case that really happens — an agent that stops
answering — would never have been evicted. The sweep is lazy, on
write and read: **no new timer**.

**What it does NOT do.** It writes nothing to disk. The window is lost on node
restart, and the page says so: "one hour, in memory" and "one hour, durable" are two
different promises. A durable series remains the separate decision described in
D250.
### 2026-08-27 — identity theft in the tracker: the track count does NOT go down

It is written here precisely because the number **does not move**, and the temptation to
claim a saving was real.

`growthAdjacentMatch` tied a track to a detection 573.8 px away with
IoU 0.0077, only because the two boxes had a different size — and measured the budget
on the diagonal of the **larger** box, so the bigger the intruder, the further
it could steal from (D251). The defect **did not produce fewer tracks**: the robbed
car was abandoned and was reborn 684 ms later with a new id. Before: 2 tracks, one
of which carries one car's plate and another car's position. After: 2 tracks,
each on its own car.

Direction of the load, by construction:

| rule | effect on the number of tracks |
| --- | --- |
| growth tied to the track's maturity (≤ 1500 ms) | 0 or **+** (a growth on a mature track is now born) |
| a rescue by proximity alone yields to a plausible birth | 0 or **+** |
| instrumentation of the rescue binds | 0 |

So: **zero fewer tracks, possibly a few more.** The cost per extra track is
media (thumbnail + keyFrame + possible detail dispatch); the cost of
a stolen track is corrupt data, and this is the explicit choice.

⚠ **The production measurement does not exist yet and must not be invented.** The tracker
did not have ONE log line (`pipeline/tracker/**`, zero); now every rescue
bind emits `tracker: salvage bind` with `tags: { deviceId }` and with
`stage` / `gate` / `iou` / `centroidDistPx` / `trackDiagPx` / `areaRatio` /
`dtMs` / `trackAgeMs`, sampled (first, then every 50th, with `bindCount`
carrying the exact total). The before/after is done **after the deploy**, and is done with
`count_over_time` — never by counting lines, which the helper silently truncates at 1000:

```
sum by (gate) (count_over_time({...} |= "tracker: salvage bind" [1h]))
```

The number that matters is the `gate="growth"` and `gate="centroid"` share of the total
of binds: they are the two branches that can steal, and they were invisible.

### 2026-08-27 (night) — the load series reaches disk, and what it costs

D251 kept an hour in RAM and said, explicitly, that a DURABLE series
remained a separate decision. This is that decision ([D260](../decisions/adr-0260-the-load-series-is-durable-on-a-fixed-cadence-with-a-row-cap-behind-the-retention-knob.md)),
and it is the second entry written here after the rule of this document was
formulated.

**Emission is now at a FIXED CADENCE.** Before, it emitted only on change,
with a fallback heartbeat at 60 s: a gap in the chart could mean
«nothing changed» or «nobody reported», and telling them apart is exactly
the reason one opens that chart after a spike. The cost of removing the
ambiguity is that **the row count is no longer "up to", it is deterministic**:
no discount when the fleet is quiet.

**Measurement, not estimate.** `npx tsx scripts/measure-load-series-cost.mts` drives the
real engine (`SqliteSettingsBackend`) through the real DDL of
`declareCollection`, writes one transaction per sample, does a
`wal_checkpoint(TRUNCATE)` and reads `page_count x page_size`. Table plus
index. Payload: the real shape of the fleet, 3 nodes of 42 / 20 / 14 process
rows.

| cadence | retention | rows | on disk | B/row |
| --- | --- | --- | --- | --- |
| 60 s | 6 h | 27,360 | **2.3 MiB** | 87.4 |
| **10 s (default)** | **6 h** | **164,160** | **13.6 MiB** | **87.0** |
| 5 s | 6 h | 328,320 | **27.3 MiB** | 87.1 |
| 5 s | 72 h (the knob's ceiling) | 3,939,840 | 328.8 MiB | 87.5 — **cut to 500 k rows ≈ 41.5 MiB** |

Linear in rows from 27 k to 3.9 M. The number is **per process row**: the
sustained write at the default is 7.6 rows/s in **0.3 transactions/s**, never
one transaction per row.

**Where the 196.1 → 87.0 B/row comes from**, all inside ONE table — the shape
is the operator's decision and was not bypassed:

| shape | B/row |
| --- | --- |
| naive: composite `TEXT` key, 2 indexes, every `NodeProcess` field | 196.1 |
| without `command`/`threadCount`/`uptimeSec`, a single index, CPU in integer tenths, RSS in integer MiB | 140.3 |
| + `INTEGER` key aliasing the rowid | **87.0** |

- **`command` is not stored.** It is the fattest field of a snapshot and it is the
  SAME ~100-character string on every runner: the runner's id travels
  in the environment, not in argv, so `ps` reports an identical command line
  for all. `addonId` is the short identifier that already exists, and nothing that
  draws this series has ever read `command`.
- **CPU in integer tenths is lossless.** `runPs` rounds `pcpu` to one
  decimal and `ThreadCpuTracker` does `Math.round(x * 1000) / 10`: both
  producers already emit tenths. A `REAL` in SQLite is always 8 bytes; the
  same value as an integer varint is 1-2.
- **The composite key cost ~53 B/row** — the string in the row plus its
  B-tree — to buy an idempotency that the series obtains for free elsewhere:
  `NodeLoadRing.record` now says whether the sample was ACCEPTED, and only an
  accepted sample is appended. A monotonic comparison in memory instead of
  a unique index on two million rows.

**Which disk it lands on, verified 2026-09-01.** The table is a
`declareCollection` collection inside `camstack.db`. The **live** file is the
`sqlite-settings` bind, not all of `/data` ([D328](../decisions/adr-0328-the-live-sqlite-file-is-the-bind-the-container-has-open.md)):

```
/mnt/mixed/camstack/addons-data/sqlite-settings  →  /data/addons-data/sqlite-settings
```

`/mnt/mixed` = `/dev/sdb1`, **xfs**, Samsung 870 QVO. `/data` stays mounted on
`/mnt/cache/appdata/camstack` (btrfs RAID1, [D147](../decisions/adr-0147.md)),
so a `camstack.db` still exists under cache — **frozen at 25/08**, it is not
a backup. The mechanical recordings disk is a separate `filesystem-storage`
location and the settings-store never writes there. **7.6
rows/s end up on the mixed SSD, not on the Toshiba USB.**

**The row ceiling is the guarantee, the retention is the intention.** 500,000
rows ≈ 41.5 MiB. It bites regardless of the knob, evicts the oldest and
**logs it** — it is the discipline that the in-memory ring has already adopted and that
item #5 of this register (RTP rings, 898 MB over 47 rings) does not yet have. And
the pruning is **bounded**: both limits go through an ordered page
oldest-first on the single `(nodeId, atMs)` index, never a full scan —
the defect fixed in the recorder the same week.

**What this does NOT do.** It does not reduce the cost of reading a long
window: 164,160 rows cross hub-main to be folded. It is an on-demand query, not
periodic, and is bounded in rows — but it is the next item if
someone opens it continuously.

### What was NOT the cause — and why it must be written

Every line here is a hypothesis that consumed time before falling to a measurement.

- **The fleet-read storm does not explain the steady-state load.** It is a
  ~2-minute transient per boot: **3,772/min at startup against 39/min in
  steady state**, ~1%. It must be fixed because boots are frequent, not because it weighs.
- **The in-memory log ring** has a hard ceiling of 50,000 lines / 128
  partitions ≈ 25-50 MB — two orders of magnitude below the phenomenon.
- **The stream catalog is not all-or-nothing**: `reconcileDeviceCatalog` is already
  per-device with `try/catch` and `Promise.allSettled`. The 22 error lines
  per node were **one** camera retried, not thirty failing.
- **The HTTP plane is irrelevant.** Transport census on the same boot:
  `planes={http:69, ws:17, mesh:65}`, and `deviceManager.listAll` **absent**.
  Two client fixes shipped against this hypothesis did not move the number.
- **The disk at 93.8% was a peak**, not the state: average `%util` since boot
  **62.29%**, `r_await` 35.72 ms.
- **`event-media data-plane served` is logged once at startup**, not per
  request: counting it as a request counter leads to concluding that
  traffic does not arrive, and that is false.

## How to measure, without redoing the work from scratch

- **CPU breakdown and GC share**: 60 s delta on `/proc/<pid>/task/*/stat`,
  separating `MainThread` from the `V8Worker` threads. Without this separation a
  process that allocates in bursts looks "busy" while it is collecting.
  **Since 2026-08-27 this no longer has to be done by hand**: `native-metrics` computes the same
  delta on its 20 s tick, for camstack pids only, and publishes it as
  `cpuMainPercent` / `cpuGcPercent` on `metrics.node-processes-snapshot`
  (`packages/system/src/builtins/native-metrics/thread-cpu-sampler.ts`). Cluster
  → Node → **Load** draws it stacked. Mind what it really contains:
  it is the `V8Worker` pool, of which collection is the dominant tenant but not
  the only one — background compilation lives there. `null` means
  **unknown** (non-Linux node, recycled pid, first sample), never zero.
  ⚠ The CPU column that comes from `ps pcpu` is a **lifetime average**, not a
  rate: on a runner up for days it is almost flat, and as a time series it
  says nothing.
- **Classify memory**: `/proc/<pid>/smaps` — 256 KB pages = V8 heap;
  `brk` = glibc allocator (where the Buffers of some runners end up); large anonymous
  mappings = native memory not returned. ⚠ `environ` and `maps` often give
  *Permission denied* under userns: use `status` and `ps`.
- **Count events**: `count_over_time` on Loki. The `hl loki-query` helper
  **silently truncates at 1000 lines** — counting raw lines produces
  false numbers (a count of 1000 lines "in 14 minutes" was actually 370,000 in 31
  hours).
- **Fleet reads**: the census in `fleet-read-census.ts` **arms itself
  at every boot** and closes after the window. No instrumentation needed:
  look for `fleet read census` in the logs after a restart.
- **Transport planes**: `system.getRequestCensus`, armed via
  `system.setLoggingSettings` with a `request-census` window. The expiry is
  **persisted** and restarts at boot for the remaining time, so it covers startup.
  The `planesExplainTotal` field says whether the sum of the planes explains the total: if
  it is false, **a plane is missing**, and that is the result.
- ⚠ **NEVER** `du` on `/mnt/user` (39 TB). `/mnt/disks/recordings-2` is a disk of
  its own and is measurable.
- ⚠ **NEVER** open the production SQLite DB with `sqlite3`, not even read-only,
  and **never** the namesake cache file. The live one is the `sqlite-settings`
  bind on `/mnt/mixed/...` ([D328](../decisions/adr-0328-the-live-sqlite-file-is-the-bind-the-container-has-open.md)).

### 2026-08-27 (evening, 2) — per-camera load: every addon declares its OWN cost

**Before.** Four of the five load families were per-camera **by
construction** and **none was readable**. The table of evidence
(`camera-load-attribution.ts`) said `wiredToday: false` on decode, transcode,
recording and streaming for **a single reason**: nowhere existed a
`pid → deviceId` map. The registry that owns the process knew which
camera it was; the operating system's process table did not; and nothing
joined the two. The rows that decided it:

| Family | Per-camera unit | Why not readable |
| --- | --- | --- |
| decode | one fork per session | `forkDecodeWorker(_source, …)` **discarded** the source |
| transcode | one ffmpeg per (camera, plane) | `child.pid` read **only** to send SIGKILL |
| recording | one ffmpeg per (camera, profile) | `ProcLike` **deliberately omitted** `pid` |
| streaming | one broker per `${deviceId}/${camStreamId}` | same, plus private `rtpRingBytes` |
| detection | **none** — shared pool | not attributable, ever |

Starting measurement, and it must be written because it is the number that is missing: **0 cameras out of
N** had a readable cost. Not "imprecise" — absent. Every question
"why does 102 cost more than 101?" ended in a by-hand correlation between
timestamps.

**After.** Not a `pid → deviceId` map, which was the obvious and wrong fix.
**Each addon contributes its own statistics, already attributed**,
through the `load-contribution` capability (`mode: 'collection'`,
`internal: true`, `mount: { kind: 'skip' }` — the shape of `log-channels` and
`log-destination`, D248). The recorder **already knows** it spawned an ffmpeg for
101 profile `high`: nobody has to deduce it.

| Who | Where it claims | Where it releases |
| --- | --- | --- |
| `recorder` | `SegmentWriter.start()` (`deps.claimCost(proc.pid)`) | `onTermination()`, before any early return |
| `stream-broker` (transcode) | `TranscodeEgress.spawnAttempt()`, **one per generation** | `child.once('exit')` **and** `once('error')` — the hw→sw fallback spawns two children |
| `stream-broker` (streaming) | `FfmpegPushReader.connect()` | `fireTeardown()`, the single point on all three terminal paths |
| `pipeline-runner` (decode) | `forkDecodeWorker()`, with `source.deviceId` — the source that used to be thrown away | `child.once('exit')` |
| `detection-pipeline` | — | — declares `deviceId: null` + `attribution: 'unattributable'` |

**Why no shadow registry.** The pair travels nowhere: the
claim is a `Map` **in the process that spawned the child**, and dies
with the process — which is correct, those children were its own. `claim()` returns a
**handle**, and the handle is the only way to release: a `release(pid)`
would let a late release delete the **live** claim
of a process that inherited the same pid, which is exactly how one camera's load
gets charged to another.

**Absent, never zero.** `cpuSeconds` and `rssBytes` are read from `/proc/<pid>` **at the
moment the contribution is requested** — no new timer, no new
sampling. On a node without `/proc`, or on a child that died between
the claim and the read, the fields are **omitted**. A zero would say "this
camera cost nothing", which is a measurement nobody made.

**Cumulative, not a rate.** A rate needs a window, a window
needs a sampler, and a high-frequency per-node sampler is the
defect that half of this register documents. A counter is differentiated by whoever
already keeps a history; an average cannot be re-decomposed.

**The observer stays, and has a new job.** `metrics.node-processes-snapshot`
measures every camstack-shaped process that runs, claimed or not. The
**difference** is the datum: a process that no contribution names is either a
leak or a cost family that nobody has taught to declare itself.
`foldContributionsByCamera` keeps it in the `unclaimed` bucket and **never** folds it
onto a neighbouring camera; `claimCoverage` reports the pair
("43 of 47"), not a percentage.

**What has NOT changed, and that is the point.** `streaming` stays `wiredToday: false`:
only a source with an ffmpeg parser spawns a child, and a native source has
none — its streaming cost is ring occupancy **in
process**, and `rtpRingBytes` is still private. Flipping that row
would promise a number for every camera while delivering it only to those that by
chance use ffmpeg. And `detection` stays refused by `isChartablePerCamera`: the
novelty is that now **the pool declares it**, instead of letting an
observer deduce it. The refusal has become a datum.

**Defence against pid recycling, and a real defect found along the way.**
`cpuSplitBetween` (`thread-cpu-sampler.ts`) rejected a window only when the
ticks went **backwards** — i.e. only when the new process was **less**
busy than the dead one. A pid recycled onto an ffmpeg that has been transcoding for a minute
produces a **large positive** delta, which splits cleanly and is drawn as a
spike. Now the window is also rejected when `starttime` changes
(field 22 of `/proc/<pid>/stat`), which is the pid's incarnation number, and
when `starttime` is **unknown** on either side. `null` = unknown,
never zero.

**What remains to be done, and it must be said**: the read path exists
(`system.getLoadContributions`, admin) and the fold is tested, but **no
admin UI panel draws it yet** — the attribution table now
tells the new truth, the per-camera chart does not.

### 2026-08-27 (evening, 3) — the detection session: the load that is too LOW

The rest of this register looks for load to remove. This entry is the opposite, and
must be read as such: a detection session lasted **too little for the
downstream function to exist**, and the fix deliberately **raises**
the detection uptime. The starting number serves exactly as always —
without it, "we raised it enough" is an opinion.

**Before.** Camera 102, 24 h, 503 sessions paired from the logs (no
truncation):

| p10 | median | p90 | ≥30 s |
| --- | --- | --- | --- |
| 10,002 ms | **10,221 ms** | 18,150 ms | **4/503 (0.8 %)** |

It is not a duration, it is the **floor** `MIN_SESSION_OPEN_MS` (10,000 ms): 53 %
die within 500 ms of it. Closures: `motion_cleared` 502, cooldown 1,
`maxSessionHoldMs` 0, «held open» branch **0**. Starting detection uptime,
measured: **7.9 %**.

From 503 sessions and 7.9 % of 24 h the effective **average** duration is derived:
0.079 × 86,400 s ÷ 503 = **13.6 s** per session. It is the number to start from.

**After (estimate, not yet measured in production).** The session is now kept
open while a subject is PRESENT, capped by `maxSessionHoldMs`. The two
populations separate like this:

| population | how many | duration before | duration after | why |
| --- | --- | --- | --- | --- |
| closures with a subject still alive | 223/503 (**0.44 per closure**) | ~10.2 s | ~40 s | the still subject reaches promotion: 5.3 s of warm-up + 30 s of window + 4–6 s of tail |
| closures on an empty scene | 280/503 | ~10.2 s | ~10.2 s | no presence to consult: the floor decides as before |

221 sessions × +29.8 s = **+6,586 s/day**; the tail on the others adds
~+282 s. Total 6,826 → **≈13,700 s/day = 15.9 %**. With the uncertainty on the real
life of the tracks (censored: they were killed by the teardown, so their
natural duration is not observed) the honest estimate is **7.9 % → 14–18 %**, i.e.
**about double**.

**The ceiling, which is the part that matters.** If every session reached
`maxSessionHoldMs` (120 s): 503 × 120 s = 60,360 s = **70 % uptime**. Between the
estimated 15.9 % and that 70 % there is no estimate: there is `maxSessionHoldMs`, and that is
why the ceiling is fixed by a test and by a build guard
(`scripts/check-stationary-promotion-reachable.ts`) and not by a comment.

**The worst failure this fix could have introduced, and what prevents it.**
«Keep open while a track is alive» alone makes a parked car keep the session open **forever**: 100 % uptime on every
camera that frames one. It does not happen because the presence signal is
derived from the `result.tracked` set **after suppression**: promotion
does `processor.dropTrack` and from there the registry suppresses the detections
that match its entry, so the promoted object stops being present
by itself and its later detections reopen nothing. **It is promotion that
ends the wait** — the orchestrator does not even know what a promotion is.

**A structural cost that is reported and not fixed here.** Between the opening
of the session and the **first** observation of a track there pass **5.3 s median**
(decode + model warm-up + the tracker's confirmation gate). Of a
10.2 s session, fewer than 5 produced a track: **over half of the detection
time paid for produced nothing**. It is not caused by the defect fixed here and
is not resolved by this fix — it is the reason the guard requires
`PROMOTION_WINDOW_MS + 6 000 ms <= DEFAULT_MAX_SESSION_HOLD_MS` instead of
comparing the two bare numbers. It deserves a measurement of its own: if the warm-up dropped to
1 s, the estimated 15.9 % would drop by about 2.5 points **without removing anything**.

**What to measure to declare it successful**, in the same form as the
previous entry: the same pairing query on the 102 logs for 24 h after the
deploy, and the three numbers that must change this way —
`held open — subject still present` from 0 to >0, closures with
`subjectPresent: true` under the ceiling, and the p90 of the duration **above**
`PROMOTION_WINDOW_MS`. If the p90 stays under 30 s the fix has not reached
production, whatever the code says.
now tells the new truth, the per-camera chart does not. *(Closed by the following entry.)*

### 2026-08-27 (night, 2) — the per-camera chart, and the two ways of getting it wrong that you cannot see

Last missing surface. The plumbing was all there: the contributions
(`load-contribution`), the tested fold (`foldContributionsByCamera`), the
attribution table, the durable series (D260). The drawing was missing — and
drawing it had **two ways of being false that look normal
on screen**. Both are the entry, not the panel ([D262](../decisions/adr-0262-a-per-camera-cost-is-differenced-from-a-counter-on-the-cadence-that-already-exists.md)).

**1. The lifetime average disguised as a rate.** `cpuSeconds` is cumulative and
every entry carries `startedAtMs`: `cpuSeconds ÷ (now − startedAtMs)` is one
subtraction away and is **exactly the `ps pcpu` column** that this very page
warns against. Real numbers, from the same writer:

| quantity | value |
| --- | --- |
| counter after one hour of life | 100 s |
| lifetime average | **2.8%** |
| spent in the 10 s window | 4 s |
| real rate of the window | **40%** |

A factor of **14**, and on a writer up for days the average is a flat line
by construction: the 692% tick that opened the whole load investigation
would not have moved it. The obvious fix — sampling the counter ourselves — is the
defect that half of this register documents. Hence: **delta of two readings
that the page took by itself, on the cadence the node emits anyway**
(`metrics.node-processes-snapshot`), and **no reads with the panel closed**.

**2. The pid claimed on another node.** Found by construction, without a
symptom. `system.getLoadContributions` answers from the hub and returns **the whole
cluster** — `buildLoadContributionPlane` enumerates the registry, which keeps an
RPC proxy also for the agents' providers. The Load card is **per node**.
Subtracting a cluster-wide set of claimed pids from the process snapshot of ONE node
marks as claimed an unclaimed process of that
node every time another machine runs a process with the same number.
Nothing fails: **the only datum this surface exists to
produce disappears** and the pair reads «47 of 47» while a leak runs. On three nodes
that spawn dozens of short-lived ffmpegs the collision is ordinary.

The node is already in the payload: the hub reports the **registry key** as
`addonId`, and that key is bare for a hub provider and
`` `${addonId}@${nodeId}` `` for an agent (a rule written in
`moleculer.service.ts`, read by `CapabilityRegistry.nodeOfKey`). No new
field on the wire: a second carrier of a fact already present is a second
thing that can contradict the registry.

**What has NOT changed, and it is half the work.** `isChartablePerCamera` continues
to refuse detection, and it is now the **gate of the chart**: the drawable roles
are derived from `CAMERA_LOAD_ATTRIBUTION`, so the chart cannot
disagree with the table. `streaming` stays out for its own reason, different and not to be confused: only an ffmpeg source spawns a
child. `CameraLoadAttributionRow` **did not gain a field for a value**.
And the reduction was not rewritten: the one for the chart remains the sole
`load-series-fold.ts`, server side, which keeps minimum and maximum.

**A gap stays a gap, here too.** A window is `null` — never zero, never
interpolated, never the previous point extended — if it contains a unit without a
counter, a unit whose `startedAtMs` changed (restart, or recycled pid),
a unit that disappeared between the two readings, or a counter that went backwards. On
`1441/high`, 45.8 restarts/h measured above, this means a **broken
line**: it is the correct picture, and it is also a readable symptom of the
writer storm.

**Proofs, each disarmed and seen RED before being restored.**

| property | how it was disarmed | what the red said |
| --- | --- | --- |
| a spike survives the reduction (6 h at 10 s → 720 points) | `reducePoints` replaced by sampling every N in `mergeLoadSeries` | `expected 8 to be 692` — the spike skipped entirely |
| detection is not drawable per camera | `isChartablePerCamera` also accepts `accounted` | `expected ['decode','detection',…] to equal ['decode','recording','transcode']` |
| a gap stays a gap | non-measurable window returning `0` instead of `null` | `expected [40, +0, 20] to equal [40, null, 20]` |
| unclaimed ones do not end up on a neighbour | `contributionsOnNode` returns the whole cluster | `expected 2 to be 1` — the agent's process 777 marked as claimed |

**Idle cost added: nil.** No new timer, no new sampler,
not one extra line on any node. With the panel open: one read of
`getLoadContributions` per cadence, which reads `/proc/<pid>` of only the children already
claimed — the capability's contract provides for exactly this
caller («answered on whatever beat the caller already has»).

**And the card now says which promise it is keeping.** The per-addon charts
read the **durable** series (`durable`, `bucketMs`, `retainedSamples`
already arrive from the read and were not exposed): the copy still said «nothing
is retained: the window is since the page was opened», false since D251 and
doubly false since D260. The per-camera panel says the opposite, because
for it that is true: the contributions are not retained anywhere.

### 2026-08-28 — the cold start of detection: where the 4.7 s are NOT

A **latency** entry, not CPU/RAM, and it is here because of the rule: without the starting number
«we made it faster» is an opinion. The added value of this
entry is the **two hypotheses that the measurement discarded**, because both were
plausible, both were proposed, and both would have had people working
for weeks on a term that is not there.

**Before (measurement, fleet, 6 h, untruncated `count_over_time` counts).**
From `session-decode: detection first frame`, 20 cameras, ~2,400 dispatches:

| segment | measurement |
| --- | --- |
| motion → attach | 13-14 ms |
| `dialMs` (broker acquire) | p50 **10 ms** |
| `spawnWaitMs` (queue of the 8 slots) | p50 **0** |
| `forkToFrameMs` | p50 **4,689 ms** |

`forkToFrameMs` per camera (p50, 6 h): 637 **10,807**, 109 5,777, 3830 5,708,
618 5,369, 3628 5,341, 1443 5,138, 587 4,938, 102 4,682, 101 4,560 … and at the bottom
three fast ones: 592 **1,924**, 1441 **1,656**, 3836 **1,487**.

#### A wrong measurement, and why it must be written

The first measurement attempt read `withheld` and `spanMs` from the line
`restream prime (lat-probe)` and concluded **«0 withheld joins on every
camera»**. It is false, and false for a reason that is worth more than the conclusion:

```js
if (withheld > 0) this.reportDrops(false)
if (served.length === 0) return          // <-- the info line is NOT emitted
this.logger?.info('restream prime (lat-probe)', …)
```

That line exists **only when at least one session was served**. A join
withheld and alone produces no line, so counting `withheld` there measures
`withheld` **conditioned on having served someone**: systematically ~0. For
the same reason the logged `spanMs` is **censored at 2,000 ms** (beyond the bound
nobody is served, hence no line), and deducing the IDR interval from
`2 × p50` on that sample gives a low and wrong answer. The comment in the
code already said so — «the `restream prime` info line returns early when
nothing was served, which is exactly why device 108's blind starts were
unattributable» — and it was read only afterwards.

The unconditioned line is the **warn** `restream dropped packets`, which
`reportDrops` emits precisely when something was withheld.

**Hypothesis 1, CONFIRMED: the join burst is withheld, and the session waits
for an IDR.** The mechanism is in `join-burst-bound.ts`, which writes down its arithmetic
without drawing the consequence: the ring holds `[last keyframe .. now]`, so
the span at join is the time since the last IDR, **uniform in `[0, IDR]`**. Under a fixed
bound of 2,000 ms, a camera with a 4 s GOP is withheld **on about
half the joins** — and above the bound the burst is not cut, it is
**withheld WHOLE** (`rtsp-restreamer.ts`, `else if (overSpan …)` branch, which
also applies to the detection session).

Measurement, 6 h. Withhold decisions from the unconditioned warn, and fraction of
detection dials actually served (`detectionIntentServed` / number of
`detection first frame` lines):

| dev | `primeWithheldSpanMs` (decisions) | served | `forkToFrameMs` p50 |
| --- | --- | --- | --- |
| 1441 | **0** | **111/111 = 100 %** | **1,655** |
| 3836 | 171 | **27/27 = 100 %** | **1,487** |
| 592 | 28 | **345/351 = 98 %** | **1,946** |
| 103 | 6,857 | 27/44 = 61 % | 4,662 |
| 3835 | 6,164 | 90/147 = 61 % | 4,531 |
| 101 | 31,150 | 70/125 = 56 % | 4,560 |
| 102 | 2,142 | 15/27 = 56 % | 4,682 |
| 618 | 21,583 | 38/74 = 51 % | 5,369 |
| 3829 | 24,728 | 105/200 = 53 % | 5,257 |
| 3839 | 16,898 | 58/121 = 48 % | 4,918 |
| 104 | 119,619 | 172/374 = 46 % | 5,040 |
| 587 | 7,369 | 18/40 = 45 % | 4,938 |
| 1443 | 64,773 | 175/396 = 44 % | 5,138 |
| 637 | 22,172 | **23/77 = 30 %** | **10,807** |

The **only three cameras served on ~100 % of joins are the three fastest
in the fleet** (1.5-1.9 s against 4.5-5.8 s), and the slowest overall is the one
served least of all. The distribution is bimodal in the predicted direction.
*(The withhold decisions are counted per packet, not per join —
`servePendingSessionsRtp` runs at every packet — so their absolute value
is not a join count: the signal is zero-versus-non-zero and the ordering.)*

**The real IDR interval, by two independent routes.** Served ≈ 50 % under a
2,000 ms bound ⇒ `IDR ≈ 4,000 ms`. And the median of the span **censored at
2,000** is ~1,000 ms on eleven cameras, which is exactly what `uniform[0, 4000] | ≤2000`
predicts. Both confirm the operator — **100 GOP at
25 fps = 4,000 ms** — and refute the «8.0 s» of the docblock of
`session-decode-coordinator.ts`, now corrected in place. 618 is at 51 %: it is the
norm, not the outlier. The real outlier is **637** at 30 % ⇒ IDR ≈ 6.7 s.

**Hypothesis 2, discarded: «seed the session from a second keyframe source».**
There is nothing to wire. The join prime already comes from the ring of the **current
GOP** (`rtpPreBufferSupplier`) — the same bootstrap as WebRTC and every
RTSP join — available whenever the source is alive and
**independently of the per-stream `preBuffer.enabled` toggle**. The keyframe is there
and is already served: when it does not arrive, it is because it was **withheld**, not
because it is missing. The fix is therefore a **setting**, not a new source.

**The second term, independent of the first.** On the three cameras that are
never withheld — i.e. with the keyframe in hand — the first frame still costs
**1,487 / 1,655 / 1,946 ms**. A decoder that has been handed a
keyframe-first GOP should not take more than a few tens of ms. In that
window, after PLAY, there are only `avformat_find_stream_info`, `Decoder.create`
and the first decode; the main suspect is the first, because on an RTP input the
container does not declare a frame rate and the probe drains the burst in milliseconds
then **waits for live packets** to estimate it.

**What was done in code.** (1) The `detection first frame` line now carries
`hwContextMs`, `demuxerOpenMs`, `decoderCreateMs`, `firstDecodeMs`,
`streamInfoProbed` — the three segments inside that window plus the HW context,
measured by the worker. They deliberately do not add up to `forkToFrameMs`: the remainder is
module loading (~0.2 s), the IPC hop and the GPU filter probe. (2) The
`find_stream_info` probe is **skipped** when the opened input already describes its
video stream (`pull-demuxer-open.ts`,
[D253](../decisions/adr-0253-the-session-decode-pull-dial-trusts-the-sdp-it-was-served.md)).
This attacks the **second** term (~1.5 s), not the first.

**What was done for the first term: the bound belongs to the CONSUMER, not
to the stream** ([D263](../decisions/adr-0263-the-join-burst-bound-is-a-property-of-the-consumer-not-the-stream.md)).
D57 exists for a consumer that **re-emits** on a real clock: the HomeKit leg
(an ffmpeg copy of the restream) never drains a backlog and turns it into
jitter for the peer — measured, a 2,996 ms burst became 3,030 ms of jitter
visible to the controller. WebRTC was already exempt, and by structure: its bootstrap
reads `getRtpPreBuffer()` directly and never goes through this decision.
A detection session is the other form: it **drains** the burst (decodes at
source rate, publishes throttled by the `FrameSlot`), fast-forwards to the live edge
and starts emitting **now**. It has no peer to disturb. The decision is
now a pure function (`admitJoinBurst`) and detection is exempt from the **span**
bound — not from `maxPackets`, which is not a knob but the parachute against
RTP timestamps that have stopped describing the stream, and in exactly that case
`spanMs` means nothing. No new setting: the `/muted-detection` suffix
on the dial path already carried the bit.

**Two fixes discarded, and why.** Raising `joinBurstMaxSpanMs` is the same
number applied to **all** consumers and reopens exactly the HomeKit
failure that D57 prevents. And `preRollMs` answers a different question: it delivers
to the session the history **preceding** the motion front, so it adds real
analysis latency — a subject seen at t−4 s reported now — while
the requirement is that detection be **live**. It stays at 0.

*(For the record: detection attaches to `native:main` on 2,148 dials out of 2,151
in the 6 h. The exemption does not withhold one more byte — it serves the current GOP
that the ring already has, whereas `preRollMs` would have required ~1.1-2.3 MB per
camera, ~35-70 MB over 30, on the ingest node.)*

**After — NOT yet measured, and how to measure it. The entry is NOT closed.** This
session is read-only on production: neither has the setting been changed
nor the new fields deployed. The two measurements to take, in the same units as the
«before» and **separately**, because they are two independent terms:

*Term 1 — the withhold (requires the broker deploy).* After 6 h, on the
cameras of the ~50 % group (108, 104, 111, 112):

1. `detectionIntentServed` / `detection first frame` lines must go from
   **~0.5 to ~1.0**. If it does not get there, the exemption is not in production and
   nothing else counts.
2. `primeWithheldSpanMs` on `restream dropped packets` must go to **0** on the
   detection population. It is the unconditioned line: it is the only one that says so.
3. `forkToFrameMs` p50 must drop towards that of the never-withheld cameras
   (**1,500-1,950 ms**), not to zero. If it drops to ~3 s and stops there,
   the withhold was only a part and the rest is term 2.
4. Non-regression check, mandatory because it is the failure D57 exists
   to prevent: `boundSpanMs` on the `restream prime` line stays **2,000** and the
   non-detection consumers stay withheld as before — the HomeKit jitter
   must not move. 637 (IDR ≈ 6.7 s) is to be looked at separately: it is the only one where the
   packet ceiling can end up biting instead of the span one.

*Term 2 — the probe (requires the `pipeline-runner` deploy).* The A/B does not
require a second deploy: `CAMSTACK_DECODE_PROBE_STREAM_INFO=1` restores the
inline probe. 6 h without the variable, 6 h with: **the difference between the two
`demuxerOpenMs` IS the cost of the probe**, per camera. The criterion: if with the
flag on it is seconds and without it is tens of ms, the probe was the term and the
fix is the fix. If instead `firstDecodeMs` dominates in both cases,
the probe was not the problem, this entry must be rewritten and the skip must be **removed**
— not kept because «it does no harm». To be read on the never-withheld cameras
(1441, 3836, 592), where term 1 does not confound the measurement.

**What was NOT the cause** (written because it costs more than it seems
to rediscover it): not the dial (10 ms), not the queue of 8 slots (p50 0), not
the absence of a keyframe to seed (the current GOP's ring always has it, and
it does not depend on the `preBuffer.enabled` toggle), not an 8 s GOP on 618 (it is at
4 s like the whole fleet), not the tracker's `minHits` gate (downstream of the first
frame, and deliberate).


### 2026-08-29 — the 6 GiB that belonged to no process, and why we read them as a leak

Symptom: the hub's 39 processes add up to **15.81 GiB** of RSS, the container
declares **23.14**. The conclusion, wrong, was «~7 GiB are missing, there is
a leak». `memory.stat` closed it in a single command:

```
anon 19 946 409 984   file 3 642 105 856   shmem 1 860 067 328   slab 95 465 928
memory.current 24 045 301 760   memory.max 34 359 738 368
```

**The sum of the per-process RSS cannot equal the container total, and
that is not a defect.** Page cache (`file`), shared memory (`shmem`) and kernel slab
are charged to the cgroup and do not belong to any process in the way
`ps` counts them. On this hub they are ~6 GiB out of 23.

The biggest piece has a name: `/sys/kernel/debug/dri/0/i915_gem_objects`
reported **6,473 shrinkable objects / 1,519,718,400 bytes** — GPU buffers that the
i915 driver places on shmem, held by two `inference_pool.py` and two
hardware decode sessions. They are inside `shmem`, hence inside
`memory.current`, and invisible in any `ps` scan.

**The real defect was not the number, it was that we had ONE reading of it.** Taken
by hand, via ssh, once. It said what was there in that instant and nothing about the
direction: if the page cache had been growing we would not have known, and
we would not have known anyway.

**Fix** (D286): the container total is read **on the tick of the process
snapshot**, with **the same timestamp**, and travels on the same event. Retention in the same two tiers (hot ring + table
`metrics:node-memory-samples`) and the **same reader** — `getLoadSeries` answers
with `containerMemory` next to `series`, reduced on the same `bucketMs`. The
reason it is not a separate method: **the question is a subtraction**, and whoever
has to make two calls compares two different instants.

**Absent is absent.** Every unavailable field is `null`, never `0`, and a node
without cgroup produces no point. A cgroup without a limit and a cgroup
limited to zero bytes must not look alike.

**Cost, measured inside the live hub's container** (2,000 iterations after
warm-up):

| Operation | µs per sample |
| --- | --- |
| `memory.current` + `memory.max` + `memory.stat` (1,282 B) and its parse | **18.63** |
| the `ps -eo` that the SAME tick already runs | **3,424** |
| debugfs miss (paid **once**, not per tick) | 3.71 |

That is **0.54 % of what the tick spends anyway**, on a 10 s tick.
No new timer, no new sampler.

**The GPU number is carried but is always `null` today, and rightly so.**
Verified the same day: `i915_gem_objects` is readable on the Unraid host
(`6014 shrinkable [0 free] objects, 1194934272 bytes`) and **does not exist inside the
`CamStack` container**, where `native-metrics` actually runs — debugfs is not
mounted. It is also **host-wide across all DRM clients**, so it is not a
component of `memory.current` and must not be subtracted. It is probed **once**
per process and then latched: a bind mount cannot appear under a running
container. To get it populated it is enough to mount `/sys/kernel/debug` read-only
inside `CamStack` — it changes the container, not the code.

**What this measurement does NOT buy**: it does not attribute. It says that the container holds
6 GiB across page cache, shmem and slab; it does not say which process caused a page to be
cached. That question needs another tool.

## 2026-08-29 — CamStack versus the reference NVR: the first like-for-like memory comparison

Read from the cgroups of the two containers on the same host, at the same instant, with
**the same 30 cameras** in prebuffer + detection. Until today we had compared
only CPU per camera; memory had never been measured because neither
exposed its own cgroup and the reference NVR was switched off.

| | CamStack | the reference NVR | ratio |
| --- | ---: | ---: | ---: |
| `memory.current` | 20,070 MB | 10,890 MB | **1.84×** |
| **`anon`** (process memory) | **15,952 MB** | **9,253 MB** | **1.72×** |
| `file` (page cache) | 3,652 MB | 1,168 MB | 3.13× |
| `shmem` | 2,038 MB | 799 MB | 2.55× |
| `slab` | 135 MB | 300 MB | 0.45× |
| `pids.current` | 1,331 | 905 | 1.47× |
| CPU (`docker stats`, same minute) | 526 % | 348 % | 1.51× |
| memory limit | 32,768 MB | **none** | — |

### The loads are NOT identical — normalise before quoting the ratio

Confirmed by the operator on 2026-08-29: **the reference NVR is recording ~10 cameras**
on the hub's NVR array, besides prebuffer + detection on all 30. CamStack
records **30 writers** (16 devices; 8 cameras continuous high+low). So on
recording we do **~1.6× the devices and ~3× the streams**, and the `anon` ratio
is not at equal work: it is to our disadvantage on a share of extra work
that we are actually doing.

With that fact, `file` stops being a dirty comparison and becomes a
**consistency check**: 3.13× of page cache against ~3× of streams written is
exactly what is expected. It is not a defect, it is the kernel keeping in
RAM what we just wrote, and it is recoverable.

Two readings remain to be qualified. The `shmem` (2.55×) is GEM buffers of the
i915 driver behind hardware decode and inference: it depends on how many sessions each
has open at that instant, so it is not stable between two readings. And the two
**write destinations are different**: the reference NVR writes to the array with parity,
CamStack to a 2.5" 5400 rpm USB disk measured saturated at 95% with
7-14 MB/s (see the section on the recordings disk). That difference is
one of configuration, not of software, and must be taken out of the count before attributing
anything to the code.

**The number to quote stays `anon`**, with the note that it covers more recording than
theirs: 15,952 MB against 9,253 MB.

A note on the model, consistent with
[2026-08-29-reference-nvr-recording-model.md](../design/2026-08-29-reference-nvr-recording-model.md)
§2.5: **the reference NVR declares no memory limit.** The absence of a ceiling is a
*consequence* of the fact that nothing they retain is O(archive) — not a
choice that can be copied on its own.

**How to redo it** (the reference NVR is often off; it is opportunistic, and must be done while it runs):

```bash
for C in CamStack reference-nvr; do CID=$(docker inspect -f '{{.Id}}' $C); \
  cat /sys/fs/cgroup/docker/$CID/memory.current /sys/fs/cgroup/docker/$CID/memory.stat; done
```

Do not stop, start or restart the `reference-nvr` container to obtain this measurement.
