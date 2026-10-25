---
id: D473
title: An allocation rate is MEASURED, against the same process's own byte counters — never inverted from a GC counter
status: proposed
date: 2026-09-12
supersedes:
covers:
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-client.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rfc4571-reader.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtp-depacketizer.ts
---

## Context

D469 measured `hub/stream-broker` at **63.3 % of a core, 36.6 % of it V8
background threads**, and 595–668 MB of `external` that is flat over two hours.
D472 then calibrated `majors/min ≈ 40 + 0.84 × churnMBps` on a laptop, inverted
the hub's observed 125–308 majors/min, and concluded the broker allocates
**~100–320 MB/s (median ~270)** against 13–25 MB/s of media — a **10x
amplification of which ~90 % was unattributed**. Three sessions then went
looking for the missing 90 %.

**There is no missing 90 %. The inversion was wrong by 1.5–4.7x.**

The hub container was restarted so that `process.debugPort` (9229) — a
container-wide singleton that hub-main had been holding — was free. With it, the
rate can be measured instead of inferred.

### 1. What the inspector says, and what it cannot say

`stream-broker` is container pid **287** (host 3650025), `CAMSTACK_RUNNER_ID=stream-broker`.
A 90 s CPU + heap-sampling profile under live traffic:

| | |
| --- | --- |
| main thread | **81.7 % idle** (68 595 of 83 928 samples at 1 ms) |
| `(garbage collector)` self | **3.84 %** |
| largest non-builtin JS self frame | `trimRtpRingToPreRollWindow` **0.97 %** |
| V8 heap-sampling total | **13.3 MB over 90 s = 0.15 MB/s** |

The main thread is not the problem, and **`HeapProfiler.startSampling` cannot
answer "who allocates" here**: it samples the V8 JS heap only. An ArrayBuffer's
backing store is external, so a 64 KB `Buffer` is sampled at the size of its JS
wrapper. Its 13.3 MB is a *count* distribution, not bytes — the first tool the
brief recommended is the wrong one for this question, and its per-site ranking
(`Buffer.from` 53 %, `createPool` 10 %) is counts.

### 2. The rate, measured read-only

`process.memoryUsage().external` rises monotonically between collections, so the
**sum of its positive deltas is the external allocation**. Polled over the
inspector with `Runtime.evaluate` — nothing installed in the target, nothing
patched — at ~17 300 samples/s (58 µs resolution), two independent 60 s windows:

| window | external allocated | freed | live set |
| --- | --- | --- | --- |
| 1 | **68.6 MB/s** (4113 MB) | 68.7 MB/s | 622–669 MB, net −10.3 MB |
| 2 | **67.5 MB/s** (4048 MB) | 67.3 MB/s | 616–664 MB, net +10.4 MB |

And the same process's own byte counters, `/proc/3650025/io`, over a clean 30 s
window with no probe attached:

| | rate | syscalls/s | mean |
| --- | --- | --- | --- |
| `rchar` (ingest) | **15.7 MB/s** | 15 965 | 986 B |
| `wchar` (egress) | **10.7 MB/s** | 14 099 | 755 B |

**67.5–68.6 MB/s of external allocation against 15.7 MB/s of ingest is 4.3x —
and 2.6x against the 26.4 MB/s the process actually moves.** Not 10x. D472's fit
was taken on a laptop at a different live-set size and Node patch, and it warned
"order of magnitude only"; the honest reading is that the hub runs one major per
**13–33 MB** allocated, not per 60 MB, so the same major rate means far less
churn. A GC counter measures the *gate*, not the flow.

### 3. Where the 4.3x goes — all of it

Two hypotheses died on measurement:

- **64 KB socket read slabs.** 70 % of the allocated bytes land in the
  65 536–262 144 B bucket, which looks exactly like libuv's 64 KiB
  `suggested_size` being allocated per read. It is not. Node **does** shrink:
  a local Node 24 test of `chunk.buffer.byteLength` vs `chunk.byteLength` over
  12 543 saturated reads gives **1.00x** — backing store always equals `nread`.
  And `/proc` forbids it arithmetically: 640/s × 64 KiB would be 42 MB/s of
  reads, but the process reads 15.7 MB/s in 986-byte syscalls. That bucket is an
  artefact of the sampler lumping ~7.5 allocations per 58 µs window; **the
  67.5 MB/s total is robust to lumping, the size histogram is not.**
- **An offset/zero-copy reframing of the parser.** Written and measured: it is
  **worse** (3.54x vs 2.77x ingest), because carrying the partial forward costs
  a copy the current code gets for free when the read buffer is empty.

What remains accounts for the whole 4.3x, per ingested byte:

| stage | cost | rate |
| --- | --- | --- |
| Node socket read buffer (`nread` each, verified 1.00x) | 1.0x | 15.7 MB/s |
| `rtsp-client.ts:397` `Buffer.concat([this.readBuffer, chunk])` per read | **1.7–1.8x** | **~27 MB/s** |
| `rtsp-client.ts:409` `Buffer.from(subarray)` per RTP packet | 1.0x | 15.7 MB/s |
| `rtp-depacketizer.ts:76` `allocAnnexBNal` / `copyIntoAnnexB`, exact-size | ≤1.0x | remainder |

The framing concat is the **single largest allocator in the process** and it is
not a defect: it copies `leftover + chunk` only when a partial frame is pending,
and simulating the exact algorithm against the measured read-size distribution
puts it at 2.04x ingest at 700 B reads, **1.77x at 946 B**, 1.17x at 4 KB. At the
measured 986 B mean it is ~1.7x. The per-packet copy at `:409` is likewise
deliberate: without it every packet retained in the pre-roll ring would pin the
whole concatenated read buffer — it is the fix for the slab pinning D472 went
looking for, already in place.

`rfc4571-reader.ts:165` carries the same two lines, for the same reason.

So the broker allocates ~4 buffers per ingested byte because the path has ~4
copy stages, each of which is load-bearing. **Nothing is unattributed.**

## Decision

**An allocation rate is measured, not inferred.** A claim about how much a
process allocates is made by integrating the positive deltas of that process's
own `process.memoryUsage().external` over a stated window, and any
*amplification* claim is stated against `rchar`/`wchar` from
`/proc/<pid>/io` for the **same pid in the same window** — never against a fleet
bitrate estimate. A GC counter (`gcMajPerMin`) may be read as evidence that
churn exists and that the retention gate is open, per D472; it may **not** be
inverted into MB/s off a fit taken on another machine, because the majors-per-MB
gate is a property of the live-set size and the V8 build, and on this hub it is
2–4.5x tighter than the laptop it was calibrated on. D472's rule stands; its
§3–§4 numeric inference does not.

## Consequences

- The premise that justified hunting a hidden allocator is withdrawn. The
  remaining levers are the four copy stages above, and the only one with room in
  it is the framing concat: a ring-buffer framer would take it from ~1.7x to
  1.0x, worth **~12 MB/s of 68 MB/s (≈17 %)** — a rewrite of the live camera
  ingest parser for 17 % of a churn figure that is itself 4.3x rather than 10x.
  **Not taken here**, and deliberately: the naive version of that rewrite was
  measured and is worse, and 17 % is inside the spread between the two windows
  and the read-size sensitivity. It is written down so it can be done
  deliberately, with these numbers, rather than discovered again.
- `HeapProfiler.startSampling` is the wrong instrument for external memory and
  must not be cited as attribution for ArrayBuffer bytes.
- The inspector is a container-wide singleton on `process.debugPort`. Whoever
  opens it (`kill -USR1 <container pid>`) **closes it** —
  `process.mainModule.require('inspector').close()` over `Runtime.evaluate`;
  neither `require` nor dynamic `import()` exists in the evaluate context. It was
  closed and 9229 verified free at the end of this session.
- The CPU question D469 raised is still open and is **not** an allocation
  question: the main thread is 81.7 % idle and GC is 3.84 % of its samples, so
  the 36.6 % on V8 background threads is the *cost per major* (marking a ~640 MB
  live set 2–5 times a second), not the *rate*. That is retention — which D472
  showed cannot be cut below the gate — so the next honest lever is the number of
  majors per MB, not the MB.

## Enforcement

Nothing automated — review only, and deliberately: this is a rule about how a
measurement is taken, not about code shape, so no guard can see a violation. What
it leaves behind instead is the method, reproducible in ~3 minutes: `kill -USR1`
the runner's container pid, poll `process.memoryUsage()` over
`Runtime.evaluate`, integrate the positive deltas, divide by `/proc/<pid>/io`,
and close the inspector. Any future amplification figure for a CamStack process
that is not accompanied by those two numbers should be treated as unmeasured.
