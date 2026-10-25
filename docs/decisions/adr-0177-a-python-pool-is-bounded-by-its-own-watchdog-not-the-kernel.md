---
id: D177
title: A Python pool is bounded by its own watchdog, not the kernel
status: accepted
date: 2026-08-18
supersedes:
applies-to:
  - packages/types/src/utils/pool-memory-watchdog.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pool-memory-guard.ts
  - packages/addon-pipeline/src/shared/process-memory.ts
  - packages/addon-post-analysis/src/embedding-encoder/shared/process-memory.ts
---

## Context

The long-lived Python inference subprocesses (`inference_pool.py` ×N,
`yamnet_audio.py`, `raw_tensor_inference.py`) grow over hours, get OOM-killed,
respawn near 100 MB and repeat. On 2026-08-18 `dmesg` showed two kills in six
hours — anon-rss 3.8 GB inside the CamStack cgroup, then 8.8 GB host-wide —
on a 62 GiB host with NO swap, and the pressure killed the co-hosted Home
Assistant VM twice. The cycle is invisible to casual sampling: measured at the
wrong moment the pools read 78–171 MB and look healthy, and the addon log ring
holds ~10 minutes, so nothing on the box could show the ramp. What was tried
first was assuming the recorder was the OOM driver; the audit disproved it.
Until this record the ONLY bound on pool RSS was the kernel OOM killer, whose
victim selection took down unrelated processes.

## Decision

Every long-lived inference subprocess is watched by the shared
`PoolMemoryWatchdog` (`@camstack/types`): one 60 s sweep logs a `pool memory`
line per pool (RSS, VmSize, peak RSS, threads, request counters, queue depths,
malloc arena count where obtainable) and restarts a pool whose max-worker RSS
crosses `min(ceiling, max(floor, 4 × settled-baseline))` — restart means the
owner's EXISTING dispose-and-lazy-recreate path, never a second process
supervisor. At most one pool restarts per sweep; each pool has a 30 min
cooldown and a bounded restart budget (6 / 24 h), past which the watchdog
stops restarting and escalates with an error log. A pool whose pid changed
outside the watchdog (kernel kill, idle eviction) is re-baselined, never
budget-charged. The policy lives ONCE in `@camstack/types` because addons must
not import each other and self-contained bundles inline the bare types entry —
so it ships with a plain `camstack deploy` of each addon.

## Consequences

A leaking pool now costs a seconds-long, loudly-logged inference gap instead
of a host-level OOM. In-flight requests at restart fail once (frames are
dropped and counted; bulk embedding passes retry per D58). The thresholds are
env-tunable (`CAMSTACK_POOL_MEM_*`); the floor means small pools may triple
legitimately without a restart, and the ceiling (3 GiB) is the last line
before the observed kill sizes. The periodic line lands in Loki, which is the
historical store — anything that only prints to the 10-minute ring is not
instrumentation. What must stay true: pool restart paths remain the
dispose-then-lazy-recreate machinery (single-flight guarded), and the watchdog
never restarts on a budget it has exhausted.

## Enforcement

`packages/types/src/__tests__/pool-memory-watchdog.spec.ts` pins the
threshold shape, cooldown, budget exhaustion, one-restart-per-sweep
staggering and the loud log lines (neutralisation-verified);
`packages/addon-pipeline/python/test_inference_pool_memstats.py` pins the
`mem_stats` payload. No guard script checks that a NEW pool type wires the
watchdog — review only.
