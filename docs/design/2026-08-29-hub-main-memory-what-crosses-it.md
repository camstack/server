---
title: hub-main's memory — the ArrayBuffers are not a set, they are a rate
last-verified: 2026-08-29
covers:
  - packages/system/src/kernel/heap-watch.ts
  - packages/system/src/kernel/transport/socket-channel.ts
  - packages/system/src/kernel/transport/socket-traffic.ts
  - packages/system/src/kernel/socket-plane-report.ts
  - packages/system/src/kernel/transport/frame-codec.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/transport/uds-event-bridge.ts
  - packages/system/src/kernel/transport/uds-event-bus.ts
  - packages/system/src/http/reverse-proxy.ts
  - packages/system/src/kernel/moleculer/addon-data-plane-facility.ts
  - server/backend/src/main.ts
---

# hub-main's memory — the ArrayBuffers are not a set, they are a rate

> Companion to
> [`plans/2026-08-29-remove-the-memory-ceilings.md`](./plans/2026-08-29-remove-the-memory-ceilings.md).
> That plan's §5e says of hub-main: *"la telemetria dev'essere spedita e letta …
> poi va identificato cosa alloca. Oggi la composizione non è misurata."* [the telemetry must be shipped and read … then what allocates must be identified. Today the composition is not measured.] This
> document is that measurement, taken 25 minutes after the heartbeat started
> emitting for the first time ([D285](../decisions/adr-0285-a-mem-heartbeat-has-a-destination-or-it-does-not-exist.md),
> `@camstack/server@1.2.186`). It answers §5e's first half and leaves the second
> half — *which caller* — explicitly open, with the cheapest experiment named.

**The one-line result.** hub-main's `arrayBuffers` reading is not a retained set
and never was: every forced compaction drops it to **12–29 MB**. What the number
measures is *bytes allocated since the last sweep*, and the process that produces
them is a **socket message plane running at ~22 000 reads/s and ~22 500 writes/s
with an average message of 0.3–0.4 KB**. It is a message-RATE problem, not a
media-bytes problem, and on this evidence it is **not** a D9/D18 violation.

---

## 1 · What was measured, and with what

Two independent instruments over the same wall-clock, on the live hub
(container `CamStack`, hub-main host pid `806378`, in-container pid 7,
`--max-old-space-size=3072`, uptime from 11:07Z):

| Instrument | What it gives |
| --- | --- |
| the `[mem]` heartbeat + `[mem] reclaim` lines in Loki | `rss`/`heapUsed`/`external`/`arrayBuffers`/`loopMax` per minute, and the live ArrayBuffer set after each forced compaction |
| `/proc/806378/io`, `/proc/806378/fdinfo/*`, `/proc/<pid>/net/dev` (read-only, over ssh) | bytes and syscall COUNTS in and out of the process, split file vs socket |

They agree, which is the reason to trust either. No heap snapshot was taken; no
hub state was mutated.

---

## 2 · The heap is not the story, and it never moves

26 consecutive samples, 11:08Z–11:31Z:

| | min | max |
| --- | --- | --- |
| `heapUsed` | 1 298 MB | 1 538 MB |
| `external` | 327 MB | **1 655 MB** |
| `arrayBuffers` | **21 MB** | **1 335 MB** |
| `rss` | 1 999 MB | **4 213 MB** (over the 4 096 MB budget) |

`heapUsed` moves 240 MB across 24 minutes and shows no trend. `arrayBuffers`
moves by a factor of **63** inside the same window. Any account of hub-main built
on the JS heap describes 1.3 GB that is not changing and misses the 1.3 GB that
is.

**Before today the composition was inferred as "~1.3 GB live V8 + native floor +
glibc pages never returned".** The first two terms survive. The third is where
the ArrayBuffer swing lives, and it is not a floor — it is traffic.

---

## 3 · The falsifier, already in the log: the live ArrayBuffer set is ~12–29 MB

`heap-watch` forces `gc({ execution: 'sync', flavor: 'last-resort' })` when
`strandedMb` exceeds `HEAP_RECLAIM_TRIGGER_MB`
(`packages/system/src/kernel/heap-watch.ts:497`). Every one of those passes
prints what `arrayBuffers` was before and after. Ten passes, one boot:

```
11:08:20  stranded=1031MB rss=3081→2089MB freed= 992MB arrayBuffers= 77MB→28MB took=579ms
11:11:00  stranded=1132MB rss=3349→2156MB freed=1193MB arrayBuffers=542MB→13MB took=869ms
11:14:02  stranded=1079MB rss=2980→1954MB freed=1026MB arrayBuffers= 60MB→12MB took=103ms
11:16:10  stranded=1160MB rss=2902→1944MB freed= 958MB arrayBuffers=147MB→12MB took=627ms
11:18:56  stranded=1031MB rss=2682→1931MB freed= 751MB arrayBuffers= 40MB→12MB took=580ms
11:22:53  stranded=1108MB rss=3442→3057MB freed= 385MB arrayBuffers=726MB→19MB took=734ms
11:24:53  stranded=1511MB rss=3535→2928MB freed= 607MB arrayBuffers=209MB→13MB took=797ms
11:26:53  stranded=1046MB rss=3366→2956MB freed= 410MB arrayBuffers=673MB→13MB took=652ms
11:28:53  stranded=2272MB rss=3974→3512MB freed= 462MB arrayBuffers= 70MB→29MB took=555ms
11:30:54  stranded=2313MB rss=3988→3507MB freed= 481MB arrayBuffers= 41MB→12MB took=560ms
```

**Ten out of ten land between 12 and 29 MB.** Nothing in hub-main is HOLDING
hundreds of megabytes of `Buffer`. A reading of 726 MB means 707 MB of *dead*
Buffers V8 had not yet swept — exactly the mechanism
`heap-watch.ts:61` already documented for an earlier boot, now confirmed on the
`hub-main` label with the number it needed.

That reframes the question the plan asks. **The right quantity is the slope, not
the level**, and the slope is computable from the reclaim pairs, because each
reclaim resets the counter to ~12 MB:

| interval | Δ arrayBuffers | duration | rate |
| --- | --- | --- | --- |
| 11:08:20 → 11:11:00 | 28 → 542 MB | 160 s | **193 MB/min** |
| 11:18:56 → 11:22:53 | 12 → 726 MB | 237 s | **181 MB/min** |
| 11:24:53 → 11:26:53 | 13 → 673 MB | 120 s | **330 MB/min** |
| 11:22:53 → 11:23:04 | 19 → **1 335 MB** | **11 s** | **≈ 7.2 GB/min** |

The last row is not steady state. It is the burst that pushed `rss` to 4 213 MB
and printed the only `OVER RSS BUDGET` line of the boot; 14 s later the process
was back inside the budget. **Both regimes are real and they differ by 20×.**

---

## 4 · Where the bytes come from: sockets, not files, and not media

> **PARTIALLY FALSIFIED 2026-08-29, same evening — §8's own falsifier fired.**
> The per-kind counters (§8 step 2) show the response plane is
> payload-dominated: in one live minute `socketTx res: 21 981 msgs /
> 660 254 kB` (mean **30 kB**, not 0.40 kB), with `pipeline-analytics`
> receiving **536 MB/min in 2 267 responses ≈ 236 kB each** — 81 % of
> hub-main's outbound response bytes to one peer, and the §5 correlation is now
> an attribution. Two other counts from the same lines: total socket **frames**
> are ~1 050/s against the ~22 500 write syscalls/s this section measured —
> bytes reconcile between the two instruments, counts differ ~20×, so ~95 % of
> the syscalls are not cap/event frames and remain unattributed (§10 stays
> open, sharper). What survives of this section: the churn-not-retained
> mechanism (§3) and the file/disk exclusions. What does not: "the cost is per
> MESSAGE" and the 0.33/0.40 kB means as a characterisation of the byte plane
> — and §6's "no D9/D18 violation … none of them was running hot" is
> **re-opened** per §8's stated condition (the shape is D18-legitimate; the
> rate × size is the finding). See
> `plans/2026-08-29-memory-cpu-checkpoint.md` (E4, E9, F5) and plan P1.

`/proc/806378/io` over two one-minute windows, with every regular-file
descriptor's `pos` sampled at both ends so file reads can be subtracted rather
than assumed:

| window | what the heartbeat said | `rchar` | `wchar` | reads/s | writes/s | avg read | avg write | file reads | disk reads |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 11:22:36–11:23:36 | the 1 335 MB burst minute | **1 510 MB/min** | **1 554 MB/min** | — | — | — | — | — | 0.2 MB/min |
| 11:28:49–11:29:50 | a quiet minute (`ab`=56 MB) | **429 MB/min** | **466 MB/min** | **21 837** | **22 520** | **0.33 KB** | **0.40 KB** | **0.73 MB/min** | 0.10 MB/min |

Four things follow, and each one closes a candidate:

1. **It is sockets.** The only regular-file descriptor whose offset advanced at
   all was `/data/logs/camstack-2026-08-29.log`, at **0.73 MB/min**. Every other
   byte of the 429 MB/min entered or left through a socket or pipe. Actual disk
   I/O is 0.10 MB/min read. *Anything that `readFile`s media is ruled out as a
   hub-main allocator — it is not happening.*
2. **It is not media.** The average message is **327 bytes in, 400 bytes out**.
   For contrast, in the same window `hub/detection` wrote 8 019 MB/min to its own
   in-group children at **12.7 KB per write** — that is what a frame plane looks
   like in these numbers, and hub-main looks nothing like it. A 64 KB proxy chunk
   or a 200 KB JPEG cannot hide inside a 0.33 KB mean at 21 837 reads/s.
3. **The two instruments agree.** The burst minute measured by `/proc`
   (1 510 MB/min in, 1 554 MB/min out) is the same minute in which
   `arrayBuffers` went 19 MB → 1 335 MB. The quiet minute (429/466 MB/min)
   sits in the 181–330 MB/min band the reclaim pairs give. **Socket throughput
   and ArrayBuffer churn are the same quantity**, which is what you would expect
   when every frame costs `encode()` plus a `Buffer.allocUnsafe` copy
   (`packages/system/src/kernel/transport/frame-codec.ts:16`) on the way out, and
   a chunk Buffer on the way in
   (`packages/system/src/kernel/transport/socket-channel.ts:111`).
4. **The cost is per MESSAGE.** ~44 000 socket operations per second on the
   process that mediates every cross-runner call. At 400 B each, the payload is
   trivial; the allocation, the msgpack encode, the syscall and the libuv
   callback are not.

---

## 5 · The ranking, by measured bytes per minute

| # | Source | Measured | How it was established |
| --- | --- | --- | --- |
| 1 | **The UDS / socket message plane** (cap calls + event fan-out between hub-main and its 38 runners, plus Moleculer to the agents) | **429 → 1 554 MB/min**, 22.5k msgs/s out, 21.8k in | `/proc/…/io` minus every file descriptor's offset growth; 128 open sockets |
| 2 | An **unattributed burst** riding on top of it | **≥ 1.3 GB in ≤ 11 s** (11:23:04) | `arrayBuffers` 19 → 1 335 MB between a reclaim and the next 2-second probe |
| 3 | **Addon data-plane reverse proxy** (recorder playback / stills / exports, snapshot media, pipeline-analytics, terminal) | container loopback total **395 MB/min**; hub-main's share bounded well below that | `net/dev` for the netns; hub-main's own read-size distribution leaves no room for 64 KB chunks at that volume |
| 4 | **Settings SQLite traffic** (`hub/sqlite-settings` is a separate runner, so every read and write crosses hub-main) | **≤ 86 MB/min** | that runner's own `wchar` delta, an upper bound on what it can have handed to hub-main |
| 5 | **The log pipeline** (UDS ingest from 38 runners → ring buffer → rotated file → Alloy → Loki) | **0.73 MB/min** to the file; 1 300–2 500 lines/min at ~600 B | the log file descriptor's offset growth; `count_over_time` in Loki |
| 6 | **Static asset serving** (admin-ui + viewer SPA) | bounded: LRU 64 entries / 32 MB (`packages/system/src/http/asset-compression.ts:65`), plus an on-disk `.br` cache | code, and 0.10 MB/min of actual disk reads |
| 7 | **Backup / export streaming** | not running in the window | the one route that genuinely buffers in hub-main is `/api/backup/download/...` at 8 MB per chunk (`server/backend/src/main.ts:955`); the recorder's export path is a data-plane pipe instead |

**The single largest source is #1, the message plane**, by an order of magnitude
over everything else that could be priced. It is also the only one whose cost
scales with the number of addons rather than with what an operator asked for.

### What #1 looks like from the other side

Per-process syscall rates in the quiet window, for the peers that talk to
hub-main:

```
                      rMB/min  wMB/min   rd/s    wr/s
hub-main               428.6    465.6   21837   22520
hub/pipeline-analytics 361.7     51.6    5794    5741
hub/pipeline-orchestr.  87.6     85.6    2248    2281
hub/provider-reolink    58.6     55.5    1906    2130
hub/provider-hikvision  55.8     72.0    1659    1097
hub/provider-homeass.    1.5      0.7    1365    1362
hub/audio-analyzer      81.1     29.4     928     924
hub/ml                   0.8      0.0      82      82     ← an IDLE addon
```

Two readings that matter. **`hub/ml` is idle and still reads 82 messages per
second** — that is the per-runner floor of the fan-out, and across ~38 runners it
is ~3 000 writes/s before any work happens. And **`hub/pipeline-analytics`
accounted for 78–82 % of hub-main's outbound bytes in BOTH windows** (1 273 of
1 554 MB/min in the burst minute; 362 of 466 in the quiet one) — the most stable
attribution in this data.

It is stable but it is not proof: `rchar` on the analytics runner also counts
page-cache file reads, and that runner owns a vector store. **This document does
not claim analytics is the destination — it claims the correlation is worth one
counter to settle.** See §8.

---

## 6 · Is any of it a D9/D18 violation?

**No — not on this evidence, and the numbers say so plainly.**

The paths that *could* have been are real and were traced:

- `stream-broker` reaches the recorder for recorded playback and scrub through
  `ctx.api.recording.readGopBytes` / `readSegmentBytes`
  (`packages/addon-pipeline/src/stream-broker/addon.ts:802`), and both providers
  live in a different runner — so those video bytes DO transit hub-main as a
  msgpack `Uint8Array`. `recording.readWindowBytes` carries seconds of native
  video the same way.
- `audio-codec` sessions push encoded frames and pull PCM every 40 ms
  (`packages/addon-pipeline/src/stream-broker/stream-broker/audio-codec-session.ts:277`)
  between `stream-broker` and `hub/decoder-*` — again across hub-main. At
  16 kHz × 1 ch × f32le that is ~3.8 MB/min of PCM per live session, each way.
- `PipelineInferenceResult` carries a whole `FrameResult`, and an
  `ObjectDetection` may carry a base64 segmentation mask
  (`packages/types/src/types/detection.ts:278`), a 512-float `embedding` as a JS
  `number[]` (`packages/types/src/types/detection.ts:295`) and a base64
  landmark-aligned face crop (`packages/types/src/types/detection.ts:324`).

Every one of them is a legitimate shape under D18 — compressed, on demand, by
handle — and **none of them was running hot in the measured windows**: a mean
message of 327/400 bytes is arithmetically incompatible with frames, crops or
GOPs dominating. The frame plane that *does* move gigabytes is
`hub/detection` → its own in-group children, at 8 GB/min and 12.7 KB per write,
**inside one process group, which is exactly what D9 prescribes**.

What is unsized is not the payload. It is the **per-message cost of a fan-out
plane nobody has ever counted** — and the fact that an idle addon still costs
82 messages/s of it.

---

## 7 · The 9 471 ms `loopMax`, and the 550–1 100 ms one that recurs

These are two different events and only one of them recurs.

**The recurring one is self-inflicted.** `strandedMb` on hub-main sat between
1 031 MB and 2 313 MB for the entire boot, and
`HEAP_RECLAIM_TRIGGER_MB` is **1 024** (`heap-watch.ts:209`). The gate is
therefore *always* satisfied, and `HEAP_RECLAIM_MIN_INTERVAL_MS` = 120 000
(`heap-watch.ts:228`) is the only thing left deciding when it fires. **On
hub-main `shouldReclaim` is not a gate; it is a two-minute timer.** Line up the
per-minute `loopMax` against the reclaim log:

| minute | `loopMax` | reclaim in that minute |
| --- | --- | --- |
| 11:11 | 1 017 ms | 869 ms |
| 11:14 | 652 ms | 103 ms |
| 11:16 | 736 ms | 627 ms |
| 11:18 | 602 ms | 580 ms |
| 11:22 | 860 ms | 734 ms |
| 11:24 | 914 ms | 797 ms |
| 11:26 | 673 ms | 652 ms |
| 11:28 | 579 ms | 555 ms |
| 11:30 | 621 ms | 560 ms |
| every minute WITHOUT a reclaim | 107–435 ms | — |

Nine for nine. **The largest recurring event-loop stall on the process that
mediates every cross-runner call is the memory patch it applies to itself**, and
it costs ~0.5 % of wall-clock in stop-the-world on a router. Two minutes with no
reclaim never exceeded 435 ms, with two exceptions worth naming rather than
smoothing: 11:23 (430 ms, the burst minute) and **11:27 (1 109 ms, no reclaim,
unexplained)**.

**The 9 471 ms one is boot.** It falls in the first heartbeat window
(11:07:57–11:08:57), which is the first 60 s of the process's life — addon fork
storm, framework closure load, first-boot scans — and it has not recurred in the
23 minutes since. Note also that `loopP50=20ms` on every single line is the
histogram's own `resolution`
(`heap-watch.ts:295`), not a real 20 ms delay; the process is not
chronically 20 ms behind.

**Not established:** whether a 9 s block recurs at all. 23 minutes of one boot
cannot answer it. The synchronous-large-read hypothesis is *not* supported —
hub-main read 0.10 MB/min from disk and 0.73 MB/min from files — but a boot-only
sample cannot rule out a periodic one either.

---

## 8 · The cheapest experiment, and it is not a snapshot

> **SHIPPED 2026-08-29, same day — steps 1 and 2 both.** Step 1 (the fan-out
> counters on the `[mem]` line) landed first and **answered itself: the event
> plane is 4 % of the traffic in this section.** So step 2 was built too, and it
> is what this section asked for: per-channel byte and message counters on the
> UDS `send` and receive paths, **split by frame kind** (`req` / `res` / `evt`),
> attributed per peer through `LocalChildRegistry.getChildSocketTraffic`
> (`packages/system/src/kernel/transport/local-child-registry.ts:277`) and
> reported as one-minute deltas by
> `packages/system/src/kernel/socket-plane-report.ts:305`. Four new fields:
> `socketPeers=<measured>/<connected>`, `socketTx=req:<m>/<kB>,res:…,evt:…`,
> `socketRx=…`, and `socketTop=<peer>:tx=<req>/<res>/<evt>:rx=…:kB=<tx>/<rx>`
> for the busiest five.
>
> **Cost, because this sits on the 44 000/s path.** `recordSocketFrame`
> (`packages/system/src/kernel/transport/socket-traffic.ts:118`) is
> **2.37–2.41 ns/call** on Node 24.17 over 20 M iterations, against
> `encodeFrame` at ~1950 ns and `FrameDecoder.push` at ~1160 ns on the same
> 0.33 KB body. With the decoder's per-frame size write the instrument adds
> **~2.5 ns per frame = 0.011 % of one core** at 44 000 frames/s. One variant
> was measured and rejected on cost alone: truncating the decoder's size array
> with `length = 0` cost **35 ns/call**, 15× the counter it feeds.
>
> §10's first open item — *which peer receives the 22 500 writes/s* — is now
> answerable from the log rather than from a correlation. Step 3 (a payload
> histogram) stays unbuilt and stays the right next step only if a single peer
> dominates.

**`LocalChildRegistry` already counts the fan-out per child, and nothing reads
it.** `getChildEventStats(childId)` returns `{ sent, suppressed }`
(`packages/system/src/kernel/transport/local-child-registry.ts:260`) and the only
callers in the repository are two unit tests. The burn-in counter the
`CAMSTACK_UDS_EVENT_FANOUT` gate was built around has never been exposed on any
router, log line or cap method.

The experiment, in order of cost:

1. **Print what already exists.** Add the top-5 children by `sent` to the `[mem]`
   heartbeat. Zero new mechanism. This alone settles whether the 22 500
   writes/s are event fan-out or cap traffic.
2. **Add bytes and frames per child, per direction, in `SocketChannel`** — one
   counter pair incremented in `send` (`socket-channel.ts:106`) and in `onData`
   (`socket-channel.ts:111`), reported alongside (1). ~20 lines. This turns
   "~80 % of hub-main's outbound correlates with pipeline-analytics" into an
   attribution instead of a correlation, and it names the caller behind the
   11:23 burst the next time one happens.
3. Only then, if a single peer dominates, look at the payload — and look at it
   as a category/method histogram, never as a heap snapshot. Nothing in this
   data suggests a retained set, so a snapshot would answer a question nobody is
   asking.

**Falsifier for this document.** If (2) shows the outbound bytes are dominated by
a handful of large messages rather than tens of thousands of small ones, the
"message-rate, not media" conclusion of §4 is wrong and §6's "no D9 violation"
must be re-opened. The 0.33/0.40 KB means are the claim, and they are the thing
to break.

---

## 9 · What this changes in the plan

- **§5e ("budget e tetto di hub-main") gains its first half.** The telemetry is
  shipped and read. The composition is now: ~1.3 GB stable JS heap, ~12–29 MB of
  live ArrayBuffers, 1.0–2.3 GB of allocator residue, and a churn of
  180–330 MB/min steady with bursts to ~7 GB/min. **The `rssBudget` still cannot
  be removed** — the process crossed it once in 25 minutes — but the reason has
  changed: it is not a leak to hunt, it is a rate to bound.
- **§5a ("togliere il reclaim") now has a hub-main number, and it cuts both
  ways.** On hub-main the reclaim is the single largest recurring event-loop
  stall (555–869 ms every ~120 s) *and* the only instrument that has ever
  measured the live ArrayBuffer set. §5a already says the removal must name the
  process; for hub-main it must also name a replacement probe, or it destroys
  the measurement in this document.
- **§0's "per hub-main non lo sappiamo ancora" [for hub-main we do not know yet] can be struck.** What is left
  unknown is narrower and nameable: *which peer, and which message*.
- **The `MALLOC_ARENA_MAX` line in §0 gets a supporting number.** hub-main's
  post-reclaim RSS floor ratcheted from ~1 940 MB (11:14–11:18) to ~3 510 MB
  (11:28–11:30) while `heapUsed` did not move, and the amount each reclaim could
  free decayed 1 193 → 462 MB. That is allocator residue accumulating under a
  churn this high — cosmetic on paper, and the thing that will reach the budget
  first in practice.

---

## 10 · What could NOT be determined

Stated plainly, because the alternative is a plausible reconstruction:

- **Which peer receives the 22 500 writes/s.** The correlation with
  `hub/pipeline-analytics` is 78–82 % in both windows and is the strongest
  single number here, but `rchar` on that runner also counts page-cache file
  reads and it owns a vector store. Per-socket counters do not exist in `/proc`.
  §8 settles it for ~20 lines of code.
- **What the 11:23 burst was.** ≥1.3 GB of Buffer in ≤11 s, once, with no log
  line naming it. Nothing in the deny-listed event categories or the addon
  data-plane routes was correlated to that second.
- **Steady state versus event-driven, properly.** Everything above is **25
  minutes of ONE boot**, the first this process has ever reported. The two
  regimes seen (181–330 MB/min, and a 7 GB/min burst) differ by 20×, which is
  precisely the range in which a daily rhythm — a viewer session, a scrub, an
  export, the backup window — would hide. **Separating them needs 24 hours of the
  heartbeat, not more code**; 48 h would additionally cover a weekday/weekend
  difference in viewer load. Until then no claim in §5 about which source
  dominates *over a day* is supported, only which dominates in these windows.
- **The container's 395 MB/min of loopback traffic** is measured but not
  attributed to a process; `net/dev` is per-namespace and every process in the
  container shares it.
- **`cpuGcPercent`** was not used, per the plan's own standing warning that
  nobody has established what it measures.
