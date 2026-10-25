---
id: D235
title: A runner bounds its NATIVE allocator, not only its V8 heap — and no heavy runner is left uncapped
status: accepted
date: 2026-08-25
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/runner-native-allocator.ts
  - packages/system/src/kernel/moleculer/process-service.ts
  - packages/addon-pipeline/package.json
---

## Context

The hub container is capped at 24GiB and `memory.current` rode at 21-24GB, with
`memory.events` counting hundreds of thousands of `max` hits. Near the limit the
kernel performs direct reclaim **in the context of the task that allocates**, so
processes that share the cgroup stall together — measured as four idle, mutually
unrelated runners sharing one ~39s stall in the same sample, and 36.6% of all
`[mem]` heartbeats reporting `loopMax > 1000ms`.

The first hypothesis was a leak. It was wrong: the `arrayBuffers` FLOOR of
`hub/pipeline-analytics` returns to ~1MB every reclaim cycle. Its peak rises; its
floor does not.

The second hypothesis was that the V8 ceiling was the lever. That was also wrong,
and this is the part worth keeping. `hub/pipeline-analytics` reached **7334MB RSS
with `--max-old-space-size=1024` in force the entire time** — its old space peaks
at 343MB `heapTotal` while `external` peaks at 5479MB. Its reclaim line reads
`stranded=2552MB … arrayBuffers=81MB→29MB`. The OOM kill that restarted the
container on 2026-08-25 was not even a Node process: the kernel killed a
**Python** `inference_pool.py` at 5.68GB anon-rss / 49GB `total_vm`, a process
carrying 238 threads. `--max-old-space-size` was never going to reach any of it.

What all of them share is `malloc`. With `MALLOC_ARENA_MAX` unset, glibc opens up
to `8 × ncpu` arenas — 160 on this 20-core host — each holding its own free list,
returned to the OS only when the top of that arena is free. The Python pool's
12.4GB of address space on 517MB RSS is that arithmetic made visible.

Separately, the media path carried `execution.maxOldSpaceMb: 0`, set on
2026-08-17 after a FLAT 1024MB cap turned a disk-stall backlog into `Ineffective
mark-compacts near heap limit` and killed recording twice. That record diagnosed
the wrong cause. 1024MB was not "a cap" — it was a cap set BELOW the recorder's
working set, which peaks at 1647MB `heapUsed` / 2341MB `heapTotal` during the
deferred archive walk. And `0` never meant "no ceiling": it selected V8's
host-derived default, measured here as 4288MB, a number nothing in this repo
chose and that moves with host RAM.

## Decision

A forked runner is spawned with its native allocator bounded — `MALLOC_ARENA_MAX`
(default 2) — and every heavy runner carries an old-space ceiling sized from its
own measured peak `heapTotal`, never from RSS and never from the class default by
accident. `execution.maxOldSpaceMb: 0` is not a valid declaration: use a measured
number.

`VIPS_CONCURRENCY` ships welded to the arena bound and is never omitted while it
is set. `sharp` reads `MALLOC_ARENA_MAX` in its NATIVE binding and lifts libvips
concurrency from 1 to `availableParallelism()` the moment the variable appears —
measured 1 → 20 in this container. Shipping the arena bound alone would ship a
20x threading change to the busiest addon on a 75%-CPU host under the banner of a
memory fix.

## Consequences

- **Linux only, and the reason is `VIPS_CONCURRENCY`, not `MALLOC_ARENA_MAX`.**
  The arena knob is glibc's and is merely inert on macOS. The concurrency pin is
  not inert: sharp's concurrency-1 default IS the glibc defence, so off Linux
  pinning it to 1 is a pure throughput cut with no memory to show for it.
  Measured while writing this: `sharp.concurrency()` returns **6** on the
  cluster's darwin/arm64 agent and **1** in the linux hub container. The first
  version of this change exported the pair unconditionally and would have cut
  that agent 6x; caught by asking what the flag does on the node where the lever
  buys nothing, not by a test that existed.
- Anything a runner spawns inherits the bound, because Node's `spawn` without an
  `env` option passes `process.env` through. That is how it reaches the Python
  inference pool — the largest single consumer and the actual OOM victim — with
  no extra code. It also means a change here reaches processes this file does not
  name; check `spawn` sites before widening it.
- The bound costs image throughput essentially nothing (measured: mean
  51.9→51.5ms, p50 60.0→57.6ms, p99 70.7→72.9ms across 3 interleaved pairs with
  concurrency pinned on both arms) and does the same work in 30% less RSS
  (505→354MB). It was NOT priced on the Python inference path: this hub has no
  configured video pipeline steps (`pipelineExecutor.getVideoPipelineSteps` is
  `{}`) and reported `avgInferenceTimeMs: 0`, so there was no live signal to A/B.
  Two arenas across 238 threads is a lock-contention risk that remains unpriced.
  `CAMSTACK_RUNNER_NATIVE_ALLOCATOR=off` is the recovery, no rebuild needed.
- Sizing a ceiling from RSS is now a documented mistake. `stream-broker` peaks at
  1585MB RSS on a 224MB old space — ~1GB of it is `arrayBuffers` (47 RTP rings)
  that the flag cannot bound. It takes the class default; only `recorder`
  declares its own (3072MB, an effective limit of 3264MB = 1.39x its peak).
- Because no shipped manifest can now produce a runner without
  `--max-old-space-size` on argv, the boot line reporting "ceiling is V8's
  DEFAULT" is un-silenced for runners: an absent flag means manifest drift or a
  stale deploy, and is worth one line.
- hub-main is NOT covered. Both levers are container-environment knobs there
  (`CAMSTACK_HUB_HEAP_MB`, and `MALLOC_ARENA_MAX` for pid 7), and
  `serverManagement.applyServerUpdate` replaces the /data closure, not the
  container's environment. They take effect only when the container is recreated.

## Enforcement

`runner-native-allocator.spec.ts` pins the resolution rules, including that
`MALLOC_ARENA_MAX` and `VIPS_CONCURRENCY` are present or absent together.
`addon-runner.spec.ts` pins that the spawn path applies them.
`manifest-heap-ceilings.spec.ts` pins each media-path ceiling to the measurement
it came from and fails on any `maxOldSpaceMb: 0`. The live check is the spawn log
line, which now carries `arenas=` and `vips=` next to the heap flags.
