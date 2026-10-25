---
id: D469
title: A process reports its OWN CPU and names the thread that spent it — `docker stats` is the cgroup and `gcPauseMs` is one thread
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - packages/system/src/kernel/process-cpu-census.ts
  - packages/system/src/kernel/heap-watch.ts
last-verified: 2026-09-12
---

## Context

The hub container sat at 265–273 % of a core at rest and a night had been spent
removing messages from hub-main's socket plane — the audio pull cadence
(5 997 → 600 calls/min), the recorder's config reads (1 833 → ~50/min), base64 →
bytes for media (~1 285 → ~104 kB/call). All three landed, all three were
verified, and the container number did not move. The conclusion drawn was "the
message plane is not where the time goes, and nobody has profiled hub-main."

**The premise was wrong in a way no log line could have corrected.** hub-main is
not the 212 %. It is 33 %.

### The baseline, and that it had settled

The container was restarted several times that morning; the measurement waited
for it. Two clean, non-overlapping `/proc/<pid>/stat` delta windows — 120 s at
45 min uptime and 150 s at 70 min uptime — agreed:

| window | processes alive throughout |
| --- | --- |
| 120 s | 273.1 % |
| 150 s | 265.6 % |

`docker stats` on the same container sampled 175 / 178 / 352 / 352 / 411 %; the
spread is short-lived children (a `decode-worker-child` was at 138 % for the two
minutes it existed) and the reason a single `docker stats` reading must never be
quoted as a level. Host load average 4.12–4.65 on 20 cores, flat across the
hour.

### Where it actually goes

`docker stats` reports the **cgroup**: hub-main, 39 forked runners, and every
ffmpeg and python child they spawn. Per-process, at rest:

| pid | process | total | main thread | V8 workers |
| --- | --- | --- | --- | --- |
| 279 | stream-broker | **63.3 %** | 26.7 % | **36.6 %** |
| 311 | pipeline-analytics | 33.7 % | 8.1 % | 16.1 % |
| 7 | **hub-main** | **33.3 %** | 17.0 % | 15.8 % |
| 263 | detection group | 24.9 % | 7.3 % | 14.3 % |
| 286 | recorder | 23.0 % | 16.9 % | 6.1 % |
| 364 | provider-homeassistant | 22.6 % | 16.0 % | 6.5 % |
| 397 | provider-reolink | 12.1 % | 9.4 % | 2.7 % |

and outside node: python `inference_pool` 17.2 %, one `ffmpeg` transcode 11.5 %,
`yamnet_audio` 8.0 %, sixteen recorder `ffmpeg` segmenters ~12 % together.

Summed across the fleet, the container's ~270 % divides as:

| | | |
| --- | --- | --- |
| V8 background threads (11 processes) | **101.5 %** | 37 % |
| JS main threads (11 processes) | 106.9 % | 39 % |
| native children (ffmpeg, python, cloudflared) | ~55 % | 20 % |
| `libvips` threads inside pipeline-analytics | 11.5 % | 4 % |

which accounts for ~275 of the 265–273 % measured; the overshoot is that the
thread split and the process split were taken in different 75 s and 150 s
windows, and pipeline-analytics moved between them (33.7 % → 45.5 %). No term
here is precise to better than a few points, and none needs to be: the ranking
is not close.

**The single largest item in the container is V8's own background GC threads,
and no process reported it.** A 90 s V8 CPU profile of hub-main (inspector
attached by `SIGUSR1`, `Profiler.setSamplingInterval(1000)`, 83 562 samples)
puts its main thread **83.5 % idle**; the busy remainder is the UDS message
plane — msgpack `doEncode`/`encodeObject`/`encodeMap` at ~6.7 % inclusive, the
`onStreamRead → handleFrame → onData` decode at ~6.1 %, `(garbage collector)`
2.5 % self, and `formatTimestamp` (logging) 0.5 %. Nothing on that thread is
worth optimising.

### What the line said instead

`gcPauseMs` is the MAIN-THREAD pause, correctly named and correctly documented
as such by D458. It was nonetheless the only GC cost anyone could read, and it
is wrong by an order of magnitude as a proxy for what GC costs:

| process | `gcPauseMs` implies | measured V8 worker CPU | factor |
| --- | --- | --- | --- |
| hub-main | 673 ms/60 s → 1.1 % | 15.8 % | **14x** |
| stream-broker | 3 852 ms/300 s → 1.3 % | 36.6 % | **28x** |
| pipeline-analytics | 2 004 ms/300 s → 0.7 % | 16.1 % | 24x |

The worker cost tracks the major-GC rate monotonically across the whole fleet —
stream-broker 261.6 majors/min, pipeline-analytics 122.4, detection 114.2,
provider-reolink 21.8, pipeline-orchestrator 1.8, ml 0.4 — and the three worst
report `maj1308/min1`, `maj612/min0`, `maj571/min0`: **full mark-compacts with
essentially no scavenges**, which is the signature of external (Buffer)
allocation pressure, not a filling JS heap. stream-broker holds 91 MB of JS heap
inside 1 035 MB of RSS.

### D458's prediction, now measured

D458 changed moleculer's quadratic TCP reassembly and closed with: *"This has
not been measured on the hub and this record does not claim it. The measurement
that will settle it is now on the line: `gcMajPerMin` before and after."* The
patched `Parser` is confirmed live in the installed closure
(`@camstack/system/dist/index.js`, chunk-list accumulator, `Buffer.concat` once
per completed packet). Against D456's figures for the same process:

| | D456 (before) | 2026-09-12 (after) |
| --- | --- | --- |
| hub-main total | 135.7 % | **33.3 %** |
| V8 workers | 95.4 % | **15.8 %** |
| main thread | 39.6 % (busy 34.8 %) | 17.0 % (busy 16.5 %) |
| major GCs | ~60–83/min | **9.0/min** |

**D458 removed a full core and its prediction is confirmed.** The operator did
not know, because nothing reports it.

### What was tried and did not work

- **`ps` %CPU.** It is a LIFETIME average, and the container had 37 minutes of
  uptime that included its own boot. It ranked a 2-minute-old decode worker at
  138 % and hub-main at 35.6 % for reasons that had nothing to do with the
  present.
- **`/proc/<pid>/environ` to map runner pids to addons.** Permission denied even
  as `-u 0`; the mapping came from the log prefix (`[hub/<addon>] <pid>`), which
  already carries it.
- **Profiling anything other than hub-main.** Node's inspector is a singleton on
  `process.debugPort`; hub-main holds 9229 and every subsequent `SIGUSR1` logs
  `address already in use`. **stream-broker — the largest consumer in the
  container — has no function-level attribution, and getting one requires a
  restart.** That is stated here rather than guessed at.
- **`perf`.** Not installed on the Unraid host, so the V8 worker threads were
  never stack-sampled. Their attribution to GC is inference from the rate
  correlation and the marking arithmetic (~440 MB/s aggregate across 4 threads
  against a ~700 MB live set at ~10 majors/min), not a stack.

## Decision

1. **Every process reports its own CPU on its own `[mem]` line.**
   `process-cpu-census.ts` appends `procCpu=<pct>%` — `process.cpuUsage()`
   deltas over the window the line already names — after everything D446, D456
   and D458 appended, so no existing field moves and every Loki prefix written
   since 2026-08-29 still matches (D446's rule). A cgroup number is never again
   attributable to one process by assumption: the line says what this process
   cost, and the arithmetic against `docker stats` is subtraction.

2. **A GC cost names the thread that paid it, and BOTH threads are on the
   line.** `v8WorkerCpu=<pct>%/<n>thr` is the background half that `gcPauseMs`
   by design excludes. It is derived as a SHARE — V8Worker ticks over total
   thread ticks from `/proc/self/task` — scaling the exact microseconds from
   `process.cpuUsage()`, so USER_HZ cancels and no jiffy constant is baked into
   a number nobody can check.

3. **Unknown is absent, never zero (D393).** Off Linux, with `/proc` unreadable,
   with a thread delta that went backwards, or with no thread scheduled at all,
   `v8WorkerCpu` does not print. `procCpu` prints at `0.0 %`, because an idle
   process is a reading and it is the one that says a runner is alive and doing
   nothing. A window shorter than `PROCESS_CPU_MIN_WINDOW_MS` (1 s — every boot
   line) is not answered and the unread interval is KEPT for the line that can
   describe it.

4. **The name is the thread, not the cause.** `v8WorkerCpu`, not `gcCpu`: V8's
   platform workers also run background compilation, and at steady state the
   time is overwhelmingly concurrent marking but this instrument cannot prove
   which. Naming it for what it MEASURES is the same discipline that made
   `gcPauseMs` honest — and the same discipline that left this gap open, because
   an honest name for one thread is not a measurement of the other.

## Consequences

- **This does not ship with `camstack deploy`.** `process-cpu-census.ts` and
  `heap-watch.ts` are `@camstack/system`, so both ride one published
  `@camstack/server` closure (D16). Until that lands, every process keeps
  reporting a GC cost 14–28x too small.
- **Cost, per LINE and not per probe:** one `process.cpuUsage()` (~1 µs) plus a
  readdir and ~11 small `/proc` reads. Once a minute on hub-main, once every
  five on a runner. It is not on the 2 s probe path and not on any request path.
- **What is now worth doing, and what is not.** hub-main's main thread is 83.5 %
  idle; further work on its message plane buys at most a few percent of one core
  and the three fixes already shipped are the evidence. The remaining target is
  **stream-broker** — 63.3 % of the container, 36.6 % of it V8 background
  threads, 261.6 major GCs/min with 1 scavenge, 91 MB of JS heap inside 1 035 MB
  of RSS. That is the same external-allocation economy D458 diagnosed and fixed
  for moleculer's TCP path, in a process that does not use it. It has NOT been
  attributed to a function and this record does not claim a cause.
- **The inspector was opened on hub-main and cannot be closed without a
  restart.** It listens on `127.0.0.1:9229` inside the container's own network
  namespace (`br0`, its own IP), so it is not reachable from the LAN; it goes
  away on the next restart. It also means no other process in that container can
  be profiled until then.
- **`socketActions` is kilobytes, not calls.** The "374 000–648 000 calls/min"
  that this investigation was asked to explain or dismiss is a unit misreading:
  `socketActions=<labelled>/<total>kB` (`socket-plane-report.ts`), i.e. ~460–512
  MB per 60 s window across hub-main's socket plane. It is dismissed as a call
  rate; the real request rate on that plane is ~8.9–17 k req/min.

## Enforcement

`packages/system/src/kernel/__tests__/process-cpu-census.spec.ts` (14) covers
the arithmetic, the share, and every way a reading declines to exist.
`heap-watch-process-cpu.spec.ts` (4) covers the WIRING — that the fields reach
the line, in order, after the GC fields — and all four fail when the append is
removed from `heap-watch.ts` (verified by removing it). The `/proc` reader has a
live test that asserts this process finds its own `V8Worker` threads on Linux
and `null` elsewhere, so CI exercises the real parse.

Nothing guards the RULE — that a future field naming a cost must name the thread
that paid it. That is review only, and it is worth writing down because this
exact gap was documented in prose by D458 and stayed open for a day.
