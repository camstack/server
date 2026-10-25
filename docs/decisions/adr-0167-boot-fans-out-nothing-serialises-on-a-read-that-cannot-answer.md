---
id: D167
title: Boot fans out — and nothing on it waits for a read that cannot answer yet
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/system/src/builtins/core-blocks/core-blocks.addon.ts
  - packages/system/src/builtins/core-blocks/blocks-integration.ts
  - packages/types/src/device/base-device-provider.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
---

## Context

An operator asked why the hub takes minutes to become useful when the reference NVR takes
seconds. The boot of 2026-08-15T07:26:29Z was measured line by line
([boot-to-usable-camera.md](../design/boot-to-usable-camera.md)). The kernel was
not the problem — 40 runners forked and connected over UDS by **t0+10 s**. The
minutes were three independent queues, and every one of them was a `for … await`
over work that had no ordering requirement.

**A read that could not answer, awaited on the serial builtin loop.**
`core-blocks.onInitialize()` awaited `integrations.getByAddonId`. `integrations`
is a hub-CORE namespace served by the `$core-caps` Moleculer service, which
`main.ts` registers only AFTER `app.init()` returns — and `app.init()` is where
the entire addon boot runs. So during boot the call was not slow, it was
*structurally unanswerable*: it polled for the full 30 s discovery deadline and
fast-failed, and core caps are excluded from the boot-window retry, so there was
no shorter path. That 30 s sat in front of `device-manager` in the hub's serial
in-process builtin chain. Every provider runner blocks on
`awaitReady('device-manager')` before publishing a single capability, so **the
whole cluster's capability graph waited on a feature nobody had asked for yet.**
`device-manager` registered at t0+40 s; the first camera's first keyframe landed
at t0+75 s.

**Devices restored one at a time.** `BaseDeviceProvider.onRestoreDevices` pass 1
awaited `create()` per row. Thirteen Hikvision cameras came back between t0+41 s
and **t0+16 m**. `sala da pranzo` was streaming ONE SECOND after its provider
registered its caps — it was never a slow camera, it was twelfth in a queue.

**The archive walk summed instead of overlapping.** The recorder's boot hydrate
was `for (const deviceId of configs.keys()) await hydrateDeviceFromStorage(...)`.
Seven cameras, 357.5 s of `readdir`, 362 s of wall clock — the sum WAS the
clock. And `markHydratedAll` ran in a second loop after every device, so a
camera walked at minute 1 still answered `hydrationOf → 'unknown'` until minute
6, and every read of it in that window paid for a redundant on-demand walk that
contended with the walks still running.

What makes all three the same mistake: **none of the work was CPU-bound.** It is
share latency and network round-trips. Measured directly on the recordings
share, 24 cold hour directories cost 31.0 s sequentially and 16.7 s eight at a
time. Serialising latency buys nothing and costs everything.

## Decision

Boot work fans out, and nothing on the boot path awaits a read whose provider
the boot has not created yet.

Concretely, three rules:

- **A `for … await` over independent units on the boot path is a defect.** Use a
  bounded lane pool. The bound exists to protect the upstream (an NVR that
  serialises ISAPI, a share whose queue depth is finite), never to make the code
  simpler — so it is a named constant with the measurement behind it in the
  docstring, and it is overridable where an upstream demands it
  (`BaseDeviceProvider.restoreConcurrency`).
- **A unit is marked done at ITS OWN completion, never at the fleet's.** A
  camera whose walk landed is authoritative immediately. A unit that THREW is
  never marked: `unknown` is the honest answer and it is what keeps the read
  path correct.
- **`initialize()` never awaits a hub-core cap.** `$core-caps` does not exist
  during `app.init()`, so the call cannot succeed and burns the full 30 s
  discovery deadline with no retry. Arm the reconcile as bounded background work
  and let it land after boot. This narrows the existing rule in
  [addon-lifecycle.md](../architecture/addon-lifecycle.md#initialize-is-on-the-critical-path-of-the-whole-capability-graph):
  that one is about awaits that *can* outlive a boot; a hub-core cap read cannot
  possibly succeed during one, so it is not a risk, it is a guaranteed 30 s.

## Consequences

Ordering within a fan-out is no longer observable, so nothing may depend on it.
Where a dependency is real it must be an explicit barrier, not an accident of
iteration: `onRestoreDevices` pass 2 spawns a hub-adopted child only when
`restored` already holds its parent, so pass 1 must FULLY settle first, and that
is now stated rather than implied.

A bounded pool concentrates load. Four concurrent `readdir` walks against the
recordings share is deliberate — libuv's default threadpool is 4, so a higher
bound mostly queues — but the boot walk must never become the reason a live
`SegmentWriter` waits, which is why the bound is 4 and not 16.

The armed reconcile means a block that declares a device during the first
seconds finds `null` and gets its integration on the next converge tick. That
was already the documented behaviour when the API was unavailable, so no
consumer changes; what changes is that a failure is now retried instead of being
frozen into a final `null` by the first, doomed attempt.

## Enforcement

Tests, one per rule, each of which fails when its fix is removed:

- `packages/addon-pipeline/src/recorder/addon/__tests__/roots.spec.ts` —
  `hydrateDevicesFromStorage — the fleet walk`: pins the concurrency bound via
  an in-flight counter, pins that device 1 reads `hydrated` while device 2 still
  reads `unknown`, and pins that a thrown walk leaves its device `unknown`
  without stranding the fleet.
- `packages/types/src/device/__tests__/base-device-provider-restore.spec.ts` —
  pins the peak overlap, that one refusing camera does not delay the others, and
  that pass 2 still sees the complete parent set.
- `packages/system/src/builtins/core-blocks/__tests__/blocks-integration.spec.ts`
  — `armBlocksIntegration`: pins that arming returns before the reconcile
  answers, that a boot-window failure is retried, and that giving up is a log
  line rather than silence.

No guard script. The shape — `for (… of …) await` on a boot path — is not
mechanically distinguishable from a loop whose order IS load-bearing, and a
guard that cannot tell them apart would be worked around rather than obeyed.
Review only, which is why the rule is stated here in a form a reviewer can cite.
