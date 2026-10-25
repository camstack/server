---
id: D458
title: hub-main's GC is driven by EXTERNAL allocation, not by its live set — the reassembly that causes it copies each byte once, and the heartbeat carries the rate
status: accepted
date: 2026-09-11
supersedes:
applies-to:
  - patches/moleculer+0.15.0.patch
  - packages/system/src/kernel/gc-census.ts
  - packages/system/src/kernel/heap-watch.ts
last-verified: 2026-09-15
---

## Context

D456 measured where hub-main's CPU goes and left the largest item unowned:

```
PROCESS TOTAL 135.7%
   39.6%  MainThread      ← busy only 34.8%: idle 33 s of 50
   23.9%  V8Worker  x4 = 95.4%
    0.6%  libuv-worker x4
```

against a 785 MB heap with 632 MB of old space. Seventy per cent of the process
is V8's own GC threads. The open question was **whether that cost comes from the
LIVE SET (how much there is to mark) or from the ALLOCATION RATE (how often a
cycle is triggered)** — two different economies, and D443/D444/D446/D456 each
read a level and could not tell them apart.

**The live set is not the cost, and the natural experiment already existed.**
D444 cut hub-main's live set from 2 491 MB to 714 MB — a factor of 3.5 — and the
GC share did not move. That result was unreadable until the rate was measured,
because the `[mem]` line has carried the live set since 2026-08-29 and has never
carried a collection count.

**What the rate says.** A `gc` PerformanceObserver over the inspector (no
`Profiler.start`, no 867 ms stall, no snapshot — the guard stands), four windows
on the live hub between 16:46 and 17:05 CEST:

| window | major GCs | old_space fill | external alloc | V8Worker total |
| --- | --- | --- | --- | --- |
| 90 s | 0.46/s | — | — | 40 % |
| 90 s | 0.78/s | 26 MB/s | 114 MB/s | 58 % |
| 90 s | 1.11/s | 21 MB/s | 234 MB/s | 82 % |
| 90 s | 1.39/s | 23 MB/s | **537 MB/s** | **107 %** |

A full mark-compact **every 0.7 s** against a 602 MB post-GC floor under a
3 264 MB ceiling, while old space grows 22 MB/s. Twenty-two MB/s cannot trigger
a major GC every 0.7 s; V8 was answering **external-memory pressure**. The GC
rate tracks the external allocation rate across all four windows and tracks
neither the live set nor the JS-heap fill. Scavenges were flat at ~1.7/s
throughout, and the whole main-thread GC pause is 1.9 % of wall — the 70 % is
concurrent marking on the platform workers, which no in-process counter sees.

**Who allocates it, named rather than inferred.** Two candidates, measured in
one window by wrapping `Buffer.concat` and `net.Socket.prototype.push` in the
live process (both restored afterwards; the restore was asserted):

- *Node's socket read path* — the hypothesis that each read pins a fresh 64 KiB
  slab. **Falsified by direct reading**: `chunk.buffer.byteLength` equalled
  `chunk.length` on all 87 363 reads of the window. Node sizes the backing store
  to `nread`; there is no slab amplification.
- *Moleculer's TCP `Parser._write`* — **98.78 % of every `Buffer.concat` above
  64 kB**, by sampled stack, at `@camstack/system/dist/index.js:78913`. 1 273
  socket reads/s delivering **8.0 MB/s** produced **338 MB/s of concat** plus
  the matching `Buffer.from`: an amplification of **42x on concat alone, ~67x
  with both**.

The defect is in the file:

```js
packet = Buffer.concat([this.buf, chunk]);   // copies the whole remainder in
...
this.buf = Buffer.from(packet);              // copies the whole remainder out
```

Two full copies of the accumulated remainder per arriving chunk, so one M-byte
message in c-byte chunks copies ~M²/c bytes. Measured in isolation, best-of-5
with alternating order and a floor that counts the harness at 0: **a 4 MiB
message in 8 KiB chunks copies 2 056 MiB — 514x the message.** D456 had already
found this function at 20.8 % of the main thread and called it "the largest
main-thread item"; what nobody connected is that the same two lines are also the
allocation site behind the other 70 %.

**What was tried and did not work.** Reading the allocation rate from the
heartbeat's own `process.memoryUsage()` samples. At the 2 s probe cadence — and
even at 100 ms — external memory on hub-main cycles many times inside one
sample, so a sum of positive deltas under-reports by more than an order of
magnitude: 100 ms sampling said 234 MB/s in a window where 5 ms sampling of the
same phenomenon said 537. An allocation rate on this line would be a lie with a
number on it. The GC COUNT is exact at any cadence, and it is the half of the
product that was missing.

**What the armed instrument could not see.** D444's ArrayBuffer census arms at
512 MB sustained for 60 s. `arrayBuffers` on hub-main swings 9 → 917 MB and back
*inside* one minute, so the census never fired and never will for this
phenomenon: it was built for an EPISODE and this is a SAWTOOTH. That is not a
fault in the census; it is the reason a rate is a different instrument from a
level.

## Decision

1. **The TCP reassembly copies each byte once.** `patches/moleculer+0.15.0.patch`
   replaces `Parser._write` with one that holds the arriving chunks in a list
   and concatenates only when a whole packet is available. Framing, CRC,
   `maxPacketSize` and the emitted `("data", type, msg)` are unchanged, and a
   short trailing remainder is still copied into a pooled buffer so it cannot
   pin a multi-megabyte backing store until the peer speaks again. The parser is
   moleculer's file, bundled verbatim into `@camstack/system/dist/index.js`, so
   the patch is the only place this repository can change it — and the spec that
   guards it requires the INSTALLED file, not a re-implementation, or it would
   pass while the bundle stayed quadratic.

2. **A GC question is answered from the RATE and the level together, and the
   heartbeat carries both.** `gc-census.ts` puts three fields on every `[mem]`
   line, APPENDED LAST after everything D446 and D456 appended (no existing
   field moves; every Loki prefix written since 2026-08-29 still matches):
   `gc=maj<n>/min<n>/inc<n>@<window>s gcMajPerMin=<rate> gcPauseMs=<ms>`. Read
   against the `oldSpace=` already on the line the pair says which economy is
   paying — many majors with little old-space growth between them is EXTERNAL
   pressure and shrinking the live set buys nothing; majors that track old-space
   growth is a filling heap and the fix is retention. `gcPauseMs` is named for
   the thread it describes: it is the MAIN-THREAD pause only, and the concurrent
   marking that costs this process 70 % of its CPU is not in it (D456 part 4).

3. **A census that cannot observe reports NOTHING, and a window too short to
   answer is not an answer of zero.** No observer installed ⇒ no fields on the
   line, never `gc=maj0`. A window under `GC_CENSUS_MIN_WINDOW_MS` (1 s, which
   is every boot line) ⇒ no fields, and the unread collections stay for the read
   that can describe them. This is D393 applied to a rate.

## Consequences

- **Neither part ships with `camstack deploy`.** The patch is applied at
  `npm ci` and bundled into `@camstack/system`; `gc-census.ts` and
  `heap-watch.ts` are `@camstack/system` too. Both ride one published
  `@camstack/server` closure (D16). Until that lands, hub-main keeps paying.
- **The expected win is stated as a prediction, not a result.** In isolation the
  patch removes 514x/34x/18x of copying at three message-and-chunk shapes that
  bracket the hub's. If the external allocation falls with it, the major-GC rate
  should collapse from ~1/s toward the old-space-driven rate (22 MB/s against a
  602 MB live set is a cycle every ten seconds or worse), and the V8 workers
  with it. **This has not been measured on the hub and this record does not
  claim it.** The measurement that will settle it is now on the line: `gcMajPerMin`
  before and after, on the same hub, at the same hour.
- **The live set stays unattributed and that is now known not to matter for
  CPU.** ~602 MB of old space plus 111 MB of `large_object_space`; D446's ~750 MB
  of unattributed live set is still unattributed. It bounds how close this
  process runs to its ceiling — which is what killed it on 2026-09-10 — but it
  is not what the GC threads are burning. Those are two questions and this
  record separates them.
- **Every process now installs a `gc` PerformanceObserver**, i.e. one callback
  per collection into three counters, ~4/s on the worst process in the fleet.
  A process that stops its heap watch disconnects it.
- **One existing spec was changed, not deleted.**
  `heap-watch-sink.spec.ts` compared the hub's DUE line against the runner's
  BOOT line (it advanced 120 s against a 300 s runner cadence) and called that
  "one vocabulary". It passed only because no field had ever distinguished the
  two. It now advances 300 s and compares two due lines.
- **The ArrayBuffer census (D444) is not changed and is not at fault.** It is
  armed for a sustained episode; this is a sawtooth inside its sustain window.
  Anyone reading `arrayBuffers=` on a single line should know it is a sample of
  a curve that moves 900 MB per minute on this process.

## Enforcement

- `packages/system/src/kernel/moleculer/__tests__/moleculer-tcp-parser.spec.ts`
  (7 tests) over the INSTALLED `node_modules/moleculer/.../parser.js`: split
  reassembly at seven chunk sizes including 1 byte and a split header, several
  messages in one chunk, the CRC and `maxPacketSize` refusals, the remainder
  that must not pin a large buffer, and two allocation bounds — copies ≤ 3x the
  message, and 16x more chunks must not cost 4x more copying.
- `packages/system/src/kernel/__tests__/gc-census.spec.ts` (12) and
  `heap-watch-gc-census.spec.ts` (4): the counts, the window semantics, the
  unobservable runtime, the window floor, the field content, the D446 order, and
  the disconnect on stop. The real Node observer is exercised against real
  collections.

Every guard disarmed and the specs re-run:

| disarmed | red |
| --- | --- |
| the patch is reverted to upstream's `Parser._write` | 2 |
| `createGcCensus` returns a census when no observer installed | 2 |
| the census is never appended to the `[mem]` line | 2 |
| the observer is not disconnected when the watch stops | 1 |
| the window floor is removed (a rate quoted over 0 s) | 4 |

The window-floor disarm turned four red across three files, two of them specs
this change did not write (`heap-spaces.spec.ts`, `heap-watch-sink.spec.ts`
assert the line's exact content). That is the D446 field-order guard doing its
job from the other direction, and it is why the floor is a constant with a
reason rather than an `if (windowMs <= 0)`.

One thing this record cannot enforce: nothing checks that a percentage quoted in
a future plan came from a sampled thread delta rather than `ps`. That remains
review-only, as D456 wrote it down.

## Incident, recorded because it happened here

A first version of the in-process sampler read a `const` before its
initialisation and threw **895 `ReferenceError`s into hub-main's
`uncaughtException` handler** in 90 s (16:48:55 onward, 2026-09-11). The process
survived — it has a handler that continues — and the run was discarded and
repeated. Every subsequent injected sampler is wrapped in `try/catch` and counts
its own errors, and every wrapper installed on a live global is removed in the
same evaluate that reads the result, with the removal asserted. **Code injected
by `Runtime.evaluate` into production runs with no type checking and no test.**
