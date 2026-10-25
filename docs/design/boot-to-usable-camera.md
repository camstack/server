---
title: Boot to a usable camera — where the minutes go
covers:
  - server/backend/src/main.ts
  - server/backend/src/boot/init-sequence.ts
  - server/backend/src/core/addon/runner-spawn-fanout.ts
  - server/backend/src/core/addon/addon-registry.service.ts
  - packages/system/src/logging/log-manager.ts
  - packages/types/src/util/boot-recovery-backoff.ts
  - packages/system/src/kernel/moleculer/addon-runner.ts
  - packages/system/src/kernel/moleculer/trpc-links.ts
  - packages/system/src/kernel/moleculer/worker-device-restore.ts
  - packages/system/src/builtins/core-blocks/core-blocks.addon.ts
  - packages/types/src/device/base-device-provider.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/calendar-index.ts
---

# Boot to a usable camera — where the minutes go

The operator's question: *"how long does the hub take to restart, and why does
The reference NVR do it in seconds?"* The target he named: **the recording segments of a
camera fully loaded and queryable.**

Everything below is measured, from `docker logs` of the boot at
**2026-08-15T07:26:29Z** (`t0`), cross-checked against three earlier boots the
same day (1.2.111 / 1.2.112 / 1.2.113 staged swaps). Timestamps in the log body
are local (CEST, UTC+2); this page uses UTC offsets from `t0`.

> **Reading the log at all WAS the first trap** (fixed — see *F*, below). At the
> time of this measurement `LogManager` buffered every line until a
> `log-destination` provider registered, and the console destination is an INFRA
> builtin that boots *after* the whole runner plan. So the first ~40 s of boot
> produced **no stdout at all**, and then the entire backlog was flushed at once
> — **newest-first**, because `PartitionedLogBuffer.query` sorts descending. When
> re-reading a log from *before* 1.2.114, sort by the embedded timestamp, never
> by the `docker -t` one, or the boot reads backwards.

## The answer, in three numbers

| Question | Before | After the fixes in [D167](../decisions/adr-0167-boot-fans-out-nothing-serialises-on-a-read-that-cannot-answer.md) |
| --- | --- | --- |
| Container healthy, API serving | **~10 s** | ~10 s (unchanged — never was the problem) |
| First camera live | **75 s** | ~15 s expected |
| **Last** camera live | **967 s (16 min)** | ~40 s expected |
| Recording index fully walked | **385 s (6 min 25 s)** | ~120 s expected |

The kernel is fast. Forty runners are forked and UDS-connected by t0+10 s. Every
minute after that was a queue.

## The measured timeline

| t0 + | What | Evidence |
| --- | --- | --- |
| 0 s | container start, `[entrypoint]` | |
| 1 s | staged root swap → 1.2.113 applied | `[single-copy] applied staged root swap` |
| 1.5 s | 8 required packages verified on disk, **0 installs, no registry access** | `first-boot addon plan (observe) — 8 package(s), 0 to install` |
| 2 s | config, storage locations, TLS, Fastify bootstrap routes | `[Phase1]` / `[Phase2]` |
| 2 s | Moleculer broker up, UDS child registry listening | |
| 6 s | `CapabilityRegistry ready {count=151}`, 63 addons loaded from disk | |
| 6–9 s | **~40 runners forked** | `Addon runner spawned` ×40 |
| 10 s | every runner `started — N addon(s) ready (UDS connected)`; agents `agent-a` + `<agent-host>` connected | |
| 10 s | **`core-blocks` awaits `integrations.getByAddonId`** | ← the stall begins |
| 10–40 s | forked addons fail `device-manager.listAll` / `stream-broker.listAllProfileSlots` after their 3 s boot-window retry; zones mirror gives up after its 6 s budget | `resolver miss after boot-window retry` |
| **40 s** | `discovery deadline exceeded for integrations.getByAddonId after 30049ms` | |
| **40 s** | **`device-manager` registers** — the in-process builtin chain resumes | |
| 41 s | first devices restored (`#103` hikvision, `#107` reolink, `#105` amcrest) | |
| **75 s** | **first camera's first keyframe** (`hallway primo piano`) | |
| 23 s → 385 s | recorder archive walk, **7 cameras strictly sequential** | 357.5 s of `readdir` |
| 124–967 s | remaining 13 cameras come live, one per provider-restore slot | see below |
| **967 s** | **last camera live** (`sala da pranzo`) | |

### First keyframe, per camera

| Camera | first keyframe |
| --- | --- |
| hallway primo piano | t0+75 s |
| porch | t0+124 s |
| kitchen | t0+164 s |
| camera Person C | t0+367 s |
| hall | t0+384 s |
| front door | t0+384 s |
| parking | t0+388 s |
| bedroom | t0+542 s |
| garden | t0+565 s |
| cortile | t0+761 s |
| hallway cantina | t0+763 s |
| garage | t0+924 s |
| retro casa | t0+967 s |
| sala da pranzo | t0+967 s |

`sala da pranzo` was streaming **one second** after its provider registered its
caps at t0+966 s. It is not a slow camera. It was twelfth in a queue.

### The recorder walk, per camera

| Camera | `entries` | `walkMs` |
| --- | --- | --- |
| hall | 162 645 | **209 102** |
| front door | 91 261 | 82 051 |
| parking | 106 177 | 40 231 |
| retro casa | 42 274 | 14 115 |
| camera Person C | 9 545 | 10 943 |
| dispensa | 339 | 559 |
| hallway cantina | 14 | 3 |
| | | **357 549 ms total** |

Wall clock from first walk start to last completion: **362 s**. The sum WAS the
clock — the loop was `for … await`.

## The five bottlenecks, ranked

### 1. A 30 s wait for a read that could not answer (t0+10 s → t0+40 s) — FIXED

`core-blocks.onInitialize()` awaited `integrations.getByAddonId`. `integrations`
is a hub-**core** namespace, served by the `$core-caps` Moleculer service that
`main.ts` registers **after** `app.init()` returns — and `app.init()` is where the
entire addon boot runs. The call was not slow; it was unanswerable. It polled the
full `DEFAULT_DISCOVERY_TIMEOUT_MS` (30 000 ms, `trpc-links.ts`) and fast-failed,
with no boot-window retry because core caps are excluded from it.

That await sat on the hub's **serial in-process builtin chain**, in front of
`device-manager`. Every provider runner blocks on
`awaitReady('device-manager', { timeoutMs: 60_000 })` before it may publish a
single capability — so one optional feature held the entire cluster's capability
graph, and with it every camera.

**Fixed:** `armBlocksIntegration` arms the reconcile as bounded background work.

### 2. Devices restored one at a time (t0+41 s → t0+967 s) — FIXED

`BaseDeviceProvider.onRestoreDevices` pass 1 was `for … await create()`. Each
`create()` is `allocateDeviceId` + three loads + `register()`, and `register()`
runs the vendor probe (ISAPI, Baichuan). All latency, no CPU, and the rows are
independent by construction.

**Fixed:** bounded lane pool, `restoreConcurrency = 4`, overridable per provider.
Pass 2 (hub-adopted children) still runs only after pass 1 has fully settled.

### 3. The archive walk summed instead of overlapping (362 s) — FIXED

`for (const deviceId of configs.keys()) await hydrateDeviceFromStorage(...)`.

The recordings root is a FUSE `shfs` share (`/mnt/user/camstack`), where readdir
latency dominates: measured directly on the array, **one cold hour directory
costs ~1.3 s**, 24 of them cost **31.0 s sequentially and 16.7 s eight at a
time**. Overlapping is nearly free and roughly halves the wall clock.

The second half of the defect was worse than slow: `markHydratedAll` ran in a
*second* loop after every device, so a camera walked at minute 1 answered
`hydrationOf → 'unknown'` until minute 6 — and every read of it in that window
paid for a redundant on-demand walk that contended with the walks still running.

**Fixed:** `hydrateDevicesFromStorage`, four lanes, marked per device at its own
completion.

### 4. The walk starves everything that touches disk — NOT fixed

During the walk the log shows `listAllProfileSlots timed out after 20000ms`
(×536), `camera function authority TIMED OUT {timeoutMs=1200}` (×183) and
`UDS request timed out after 60000ms`. The hub's SQLite lives on NVMe
(`/data`, btrfs) while recordings live on the FUSE share, so this is share
contention plus event-loop pressure in the recorder child, not one disk.

Bounding the walk to 4 lanes reduces it. It does not remove it. See *Not done*.

### 5. Fixed retry chains that assume a healthy hub — FIXED

`provider-hikvision` logged `Initial probe did not complete — scheduling retry
chain {firstRetryMs=300000 totalAttempts=5}` for 15 devices. A probe that failed
because the hub was starved retried in **five minutes**. Nothing about the boot
justifies a five-minute first retry; the condition that caused the failure is
gone in seconds.

**Fixed:** one shared schedule, `BOOT_RECOVERY_BACKOFF_MS`
(`packages/types/src/util/boot-recovery-backoff.ts`) — **15 s → 60 s** in front
of the same 5 m → 90 m tail, so the transient case is recovered before an
operator can notice and the sleeping-battery-cam case still gets ~3 h 21 m of
coverage. It replaces two byte-identical chains: the device feature probe
(`device-cap-proxy.ts`, armed by `devices.register()` on **every** restored
device) and Tailscale auto-rejoin (`tailscale.addon.ts`, armed from
`initialize()`). The addon health monitor's first retry went 60 s → 30 s, the
tick interval — anything larger was latency on top of a wait the tick already
imposes.

## Why the reference NVR takes seconds — an honest comparison

| | the reference NVR | CamStack |
| --- | --- | --- |
| Plugin isolation | plugins in-process (or one shared fork) | **one addon = one process** ([D2](../decisions/adr-0002.md)) |
| Cross-plugin call | a function call | UDS/MsgPack or Moleculer round-trip |
| Capability discovery | an object reference | `registerNode` + a resolver |
| Recording index | prebuffer already warm; segments read on demand | on-demand `CalendarIndex` **plus** a full `RecordingIndex` walk |
| Startup verification | none | single-copy sweep + D45 duplicate scan (measured: **~1.5 s**, not a factor) |

**Replicable without giving up D2:**

- Fanning out. Nothing about process isolation requires serial iteration; this
  was the whole of items 1–3 and it is pure profit.
- Not awaiting what cannot answer. Same.
- Serving reads from a lazily-built index. **Already done** — the viewer's
  timeline reads `CalendarIndex` (shallow, request-time directory reads), not
  `RecordingIndex`. The 6-minute walk was never on the operator's critical path;
  it feeds retention, eviction and footprint. Its real cost was the disk
  contention it inflicted on everything else.

**Not replicable, and not worth wanting:**

- In-process capability calls. A crash in one provider would take the hub with
  it; the isolation is the product ([D2](../decisions/adr-0002.md),
  [D6](../decisions/adr-0006.md)).
- A warm prebuffer across a restart. The process is gone; the RTSP dial is real
  work. It costs ~1 s per camera and, fanned out, is not the bottleneck.

The honest summary: **process isolation costs about 10 seconds of boot.**
Everything else measured here was a queue, and queues are not a consequence of
the architecture.

## What was fixed, and what it is expected to buy

Three commits, each TDD'd, each test failing when its fix is removed:

| Fix | Buys |
| --- | --- |
| `armBlocksIntegration` — arm, never await a hub-core cap in `initialize()` | **−30 s off every camera**, cluster-wide |
| `restoreConcurrency = 4` in `BaseDeviceProvider` | last camera **16 min → ~40 s** |
| `hydrateDevicesFromStorage` — 4 lanes, mark per device | walk **6 min → ~2 min**; removes the redundant on-demand walks entirely |
| `buildPlaybackManifest` hydrates before deriving its profile list | a correctness bug: a cold index made the manifest report "no footage" over footage that exists |
| `beforeAddonBoot` seam — `$core-caps` on the mesh before addon boot (D171) | removes the remaining 30 s discovery deadline for **any** core-cap call during boot, not just the one call site D167 fixed |
| `spawnRunnerPlan` on 8 lanes (D171) | ~4 s of the 10 s kernel boot, and it stops growing with addon count |
| `BOOT_RECOVERY_BACKOFF_MS` — 5 min → **15 s** first retry | 15 devices per boot stop being wrong about themselves for five minutes |
| bootstrap console `log-destination` + chronological replay | the boot is readable live, in order — diagnosis, not speed |

These are expectations, not measurements — they must be verified against the
next real boot. The measurement procedure is at the top of this page.

## The proposals, and where they landed

**A. Register `$core-caps` before `app.init()`, not after — DONE**
([D171](../decisions/adr-0171-the-hub-core-api-is-on-the-mesh-before-the-first-addon-boots.md)). The asymmetry item 1 left standing: any
addon awaiting a core cap during boot got a guaranteed 30 s and no retry, while
a non-core cap gets 3 s and a retry. The boot init sequence now has one named
seam, `beforeAddonBoot` (`server/backend/src/boot/init-sequence.ts`), which runs
with the broker live and before a single addon has booted; `$core-caps` is
mounted there. Two-phase by design: **the route is on the mesh immediately, each
provider behind it completes on its own schedule** — so a caller that is early
gets an immediate typed answer instead of 30 s of silence, and the many core
routers that are hub-resident (`capabilities`, `logs`, `system`, `nodes`, …)
genuinely *answer* during addon boot now. What made it possible: the appRouter
never depended on `onModuleInit` results — `buildCapabilityRouters` is driven by
`ALL_CAPABILITY_DEFINITIONS`, declared before init, and providers resolve per
request. The comment claiming otherwise was stale.

**B. Spawn runners in parallel — DONE** ([D171](../decisions/adr-0171-the-hub-core-api-is-on-the-mesh-before-the-first-addon-boots.md)).
`spawnRunnerPlan` now runs its units through a bounded lane pool
(`RUNNER_SPAWN_CONCURRENCY = 8`, `core/addon/runner-spawn-fanout.ts`). The
ordering between the plans (forked addons → in-process builtins → isolated
builtins) is untouched — it is load-bearing and documented where it lives; the
ordering *within* a plan never was. The one hazard overlapping exposed was Node's
process-global `require.cache`: the custom-action catalog load used to purge under
the addon's bundle root before importing it in hub-main, and
`@camstack/addon-remote-storage`'s three addon ids resolve into one `dist/`, so
that purge-and-import had to be serialised per bundle. Since
[D444](../decisions/adr-0444-hub-main-measures-its-own-episodes-bounds-its-readers-and-reads-no-bundle.md)
hub-main imports no addon bundle at all — the runner describes its catalog in its
register frame — and the hazard, the purge and the serialiser are gone.

**C. Pace the archive walk against live writes — NOT DONE, deliberately.** The
four-lane walk from D167 is expected to take item 4 from 362 s of contention to
~120 s, and A + B remove the boot-time load it was competing with. Pacing adds a
second scheduling authority over the same I/O, and [D160](../decisions/adr-0160.md)'s
`LoopPacer` (the recorder's) is the only one that may exist — so if this is done
it reuses that pacer, never a new one. [D148](../decisions/adr-0148.md)
constrains the rest of the shape: the walk stays, it may never delete, it may
only stop blocking. **Revisit only with evidence from a boot measured after A/B/E**
— the `listAllProfileSlots timed out` / `camera function authority TIMED OUT`
counts are the signal.

**D. Persist the recording index — NOT DONE, deferred on purpose.** There is no
durable representation of segments — the path convention *is* the record, and
`RecordingIndex` is rebuilt from disk on every boot AND every addon deploy. A
ledger would remove the walk from the boot path entirely, with a background
reconcile for drift. Large: a new storage table, a new owner, and a drift story.
Worth doing only if C proves insufficient.

**E. Shorten the boot-time retry chains — DONE.** See bottleneck 5 above.

**F. Attach a bootstrap console `log-destination` before the runner plan —
DONE.** `manual-boot.ts` attaches a `ConsoleDestination` at the first moment a
`LogManager` exists, before anything else is constructed, and `LogManager`
detaches it — *without* a second flush — when the real `console-logging` builtin
registers (`STDOUT_DESTINATION_ADDON_ID`). Separately, every destination's
replay now runs **oldest-first**: the newest-first sort is a log-*viewer*
concern, and a destination is a stream, so the file copy of every boot was
written backwards too. The boot is readable live, in order, from line one.

## Reproducing the measurement

```bash
ssh unraid 'docker logs -t CamStack 2>&1' > hub.log
# split on '[entrypoint] backend @camstack/server' markers, then:
#   - strip ANSI
#   - parse the EMBEDDED timestamp ("8/15/2026, 9:26:49 AM", local) — not docker's
#   - convert to UTC, stable-sort ascending
```

Key greps once sorted:

| Milestone | grep |
| --- | --- |
| runner fork | `Addon runner spawned` |
| runner ready | `started — .* addon\(s\) ready` |
| the 30 s stall | `discovery deadline exceeded` |
| device-manager up | `hub/device-manager.*Addon started` |
| camera restored | `intercom cap registered` / `cap registered` |
| camera live | `First keyframe received` |
| archive walk | `hydrated a device from one recordings root` |
| walk finished | `recorder: hydrated index from storage` (now carries `ms`) |
