---
id: D288
title: The container total is a SERIES on the process tick, and absent is absent — the sum of per-process RSS is not the container's memory and never can be
status: accepted
date: 2026-08-29
supersedes:
applies-to:
  - packages/system/src/builtins/native-metrics/cgroup-memory.ts
  - scripts/check-cgroup-path-single-owner.ts
---

## Context

Every memory number camstack had was per process. The `[mem]` heartbeat is per
runner (`packages/system/src/kernel/heap-watch.ts`), and `memoryRssBytes` on a
`NodeProcess` comes from a `ps` scan. The string `cgroup` appeared once in the
whole kernel, in a comment.

On 2026-08-29 that produced a wrong diagnosis in the direction that costs the
most time. The hub's 39 processes summed to **15.81 GiB**; the container
reported **23.14 GiB**. The ~7 GiB with no owner was read as a leak and hunted
as one. Reading `memory.stat` by hand settled it in one command:

```
anon 19946409984   file 3642105856   shmem 1860067328   slab 95465928
memory.current 24045301760   memory.max 34359738368
```

Page cache, shared memory and kernel slab are charged to the cgroup and belong
to no process in the way `ps` counts. **The sum of per-process RSS can never
equal the container total**, so the difference is not evidence of anything by
itself. `/sys/kernel/debug/dri/0/i915_gem_objects` then named the largest single
component — 6 473 shrinkable objects, 1 519 718 400 bytes of GPU buffers the
i915 driver backs with shmem, held by two `inference_pool.py` processes and two
hardware-decode sessions.

That reading was taken ONCE, by hand, over ssh. It says what the container held
at that instant and nothing about direction: whether page cache was steady or
climbing was unanswerable, and would have stayed unanswerable if it had been
climbing.

Two things were tried on paper first and rejected. **A `[mem]`-style line** is
what the per-process numbers already are, and a line is not a series — the
failure being fixed is precisely that a single reading told us nothing. **A
method of its own** (`getContainerMemorySeries`) was rejected because the
question is a subtraction: an operator who has to issue two calls to compare the
process sum against the container total will compare two different instants, and
two samplers means two clocks.

The `i915` figure was investigated and deliberately not adopted as a
first-class number. It lives in **debugfs**, and debugfs is not mounted inside
any camstack container: verified on the live hub the same day, readable on the
Unraid host and `ENOENT` inside `CamStack`, where `native-metrics` actually
runs. It is also **host-wide across every DRM client**, so it is not a component
of `memory.current` and cannot be subtracted from it.

## Decision

The container's own memory is read from the cgroup on the **process-snapshot
tick**, stamped with **that tick's timestamp**, and carried on
`metrics.node-processes-snapshot` beside the process rows it must be compared
against. It is retained in the same two tiers as the process series — the
`NodeLoadRing` for the hot window, `metrics:node-memory-samples` for the cold
one — and returned by the **same** reader, `metricsProvider.getLoadSeries`, as
`containerMemory`, reduced against the same `bucketMs` and the same origin as
`series`.

Per sample: `memory.current`, the cgroup's limit, and `anon` / `file` / `shmem`
/ `slab` from `memory.stat`.

**Absent is `null`, and a node with no cgroup contributes no point at all.**
Never a zero, never a sentinel: an unlimited cgroup and a cgroup limited to zero
bytes must not look the same, and an empty `containerMemory` must stay
distinguishable from a container using no memory.

**The path is resolved, never written down.** `/proc/self/cgroup` decides v2 vs
v1 and supplies the path; the candidates are `<mount><path>` then `<mount>`, and
the first that publishes the usage file wins. The same cgroup is at
`/sys/fs/cgroup/docker/<id>` from the host and at `/sys/fs/cgroup` from inside
the container, and hard-coding either breaks the other.

The `i915` figure IS carried, as `gpuShmemBytes`, and is documented as
host-wide rather than cgroup-scoped. It is probed **once** per process and
latched — a bind mount cannot appear under a running container — so on every
node as deployed today it costs one failed `open` for the life of the runner,
one log line, and `null` on every sample.

This is measurement. No reclaim, no trimming, no ceiling and no `malloc`
tuning is added, changed or acted on from these numbers.

## Consequences

- The two numbers are subtractable **per point**, because they share an `atMs`
  by construction. "39 processes sum to X, the container says Y" becomes a
  series with a direction instead of a one-off comparison over ssh.
- `cgroup v1` is supported and reports fewer fields honestly: `rss` → `anon`,
  `cache` → `file`, and `slabBytes: null`, because v1 publishes no slab
  accounting. A v1 node and a v2 node are comparable; the `null` is what stops
  the comparison from lying.
- A developer Mac has no `/proc/self/cgroup`, resolves to nothing, logs ONE
  info line for the life of the process and reports an empty
  `containerMemory`. At the 10 s cadence a per-tick line would be 8 640 a day
  saying "still not Linux".
- Cost, measured inside the live hub container: **18.63 µs per sample** for the
  three reads plus the full 1 282-byte `memory.stat` parse, against
  **3 424 µs** for the `ps -eo` scan the same tick already runs — 0.54 % of a
  tick that fires every 10 s. A debugfs miss is 3.71 µs and is paid once, not
  per tick.
- A second durable collection, `metrics:node-memory-samples`, one row per node
  per sample: 6 480 rows at the shipped six-hour retention on the live fleet,
  4 % on top of the 164 160 the process table already writes. It is capped at
  50 000 rows — a row strictly narrower than a `metrics:node-load-samples` row,
  which was measured at 87 B, so under 4.2 MiB at the cap.
- The reduction keeps the sample with the largest `currentBytes` **whole**. A
  per-field maximum would synthesise a row whose parts never coexisted (an
  `anon` peak and a `file` peak minutes apart, summed past the total); a mean
  would erase the spike the series exists to find.
- `gpuShmemBytes` is `null` on every node today. Making it populate is a
  container change, not a code change: mounting `/sys/kernel/debug` read-only
  into `CamStack` fills it on the next sample.
- What this does **not** buy: it attributes nothing. It says the container holds
  6 GiB of page cache, shmem and slab; it does not say which process caused a
  page to be cached. That question needs a different instrument.

## Enforcement

`scripts/check-cgroup-path-single-owner.ts`, wired into the repository guards in
`.github/workflows/ci.yml`. It fails when `/sys/fs/cgroup` appears in any
production file other than `cgroup-memory.ts` — the file that resolves it.
Tests and fixtures are exempt, because a spec asserting the namespaced layout
has to spell the path out.

Behaviour is pinned by
`packages/system/src/builtins/native-metrics/__tests__/cgroup-memory.spec.ts`
and
`packages/system/src/builtins/native-metrics/__tests__/container-memory-series.spec.ts`, <!-- drift-ok: deleted when device-history replaced the LTS tier (D850) -->
against the live hub's own `memory.stat` and a cgroup v1 file — 37 assertions,
each one confirmed to go RED when the line implementing it is reverted.
