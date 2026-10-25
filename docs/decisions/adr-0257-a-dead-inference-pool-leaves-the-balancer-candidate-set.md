---
id: D257
title: A dead inference pool leaves the balancer candidate set, under a budget, and says so
status: accepted
date: 2026-08-26
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/engine/inference-device-liveness.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pool-memory-guard.ts
  - packages/addon-pipeline-orchestrator/src/inference-device-usability-mirror.ts
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
---

## Context

On 2026-08-25 the hub's `openvino:gpu` Python worker was `SIGABRT`'d by glibc
1.3 s after `Pool ready`, while compiling `yolov9m-320-int8` for the Intel GPU.
It stayed dead for 31 hours. Every frame routed to it was answered
`PoolWorker[w0]: not initialized` — ~370 000 ERROR lines, every frame lost.
Full diagnosis: `docs/design/2026-08-26-pool-not-initialized.md`.

Nothing noticed, at any layer, because **the health of a pool was an input to no
routing decision anywhere**:

- The per-dispatch capability gate is keyed on model FORMAT. `openvino:gpu` and
  `openvino:npu` share the format `openvino`, so it is blind between them by
  construction and always will be.
- The orchestrator's eligibility probe asks `platformProbe.getCapabilities` —
  about HARDWARE. The iGPU was present the entire time.
- `NodeInferenceUsabilityMirror` asks the right question at the wrong
  granularity: the NODE was fine, its NPU was healthy.
- The idle reaper's `touch()` fires on the failing branch, so the traffic that
  was failing at 13 Hz kept the dead entry alive; the memory watchdog's "every
  pid vanished" branch exempted the corpse instead of reporting it.

So the balancer kept choosing it by rotation — measured, 20 sessions in 20
minutes, every one `reason: "tie-break", tieBreak: "rotation"`, none pinned.

The obvious remedy — "rebuild the pool when it is not ready" — is worse than the
disease here. This abort is **deterministic**: same model, same device, every
time, in all 42 h of logs. An unbounded rebuild spawns one Python process per
frame at 13 Hz. That is measured, not argued: with the budget removed, the
provider spec builds 12 pools for 12 dispatches instead of 3.

## Decision

Pool liveness is a **first-class routing input**, in three parts.

1. **The runner marks it.** A per-`deviceKey` circuit breaker
   (`InferenceDeviceLivenessSupervisor`) charges one death for a cached factory
   found `!isReady()` and one for an `initialize()` that threw. Under budget:
   rebuild after an exponential backoff. Budget spent: terminal `failed`, no
   pool is spawned, and the refusal is thrown by name before a process, a model
   index or a frame copy is touched. This is `CrashSupervisor`'s discipline
   (D6) applied one layer down — bounded, backed off, terminal, **reported**.
   There is deliberately **no** success-based reset: this crash follows a
   successful spawn, so any such reset makes the budget unreachable.

2. **The channel is a poll, and the mirror is the gate.**
   `pipelineExecutor.getInferenceDeviceHealth` is a node-routed, synchronous
   read of in-memory state that never probes and never throws for its own
   reasons. The orchestrator reads it on the balancer's existing cadence and
   folds it into `InferenceDeviceUsabilityMirror` — the same arm/apply state
   machine as the node tier, keyed on `(nodeId, deviceKey)`, per D49. A read
   that FAILS changes nothing; excluding a device needs a second CONSECUTIVE
   bad observation; re-admission is immediate on one good one. An event alone
   is forbidden here: a dropped one feeds a corpse forever (D8/D11).

3. **The exclusion reuses `unavailable`.** A refused device is dropped from
   `resolveInferenceDeviceEligibility` with the reason already in the cap
   contract. That makes the node tier work for free:
   `resolveNodeInferenceUsability` counts `unavailable`, so a node whose every
   enabled accelerator pool is dead becomes node-unusable and its cameras are
   placed elsewhere.

**When nothing healthy is left, the node refuses loudly rather than degrading.**
`isPoolUsable` is deliberately NOT part of the `acceleratorServes` predicate, so
a node whose accelerators are all dead does not quietly promote its CPU. D215
measured what that costs (44% of dispatches onto a weight-1 CPU, the ONNX pool
at 647%), and a node that keeps absorbing cameras on a degraded fallback never
leaves the placement set — so the healthy iGPU on another node is never used.

**Re-entry is explicit.** The terminal state is in memory and per-runner: a
runner respawn re-derives it in three dispatches if it is still true, and it
does not outlive the driver update that fixes it. There is no timed probation —
on a deterministic abort that is just a slower respawn loop. The operator's way
out is `pipelineExecutor.rearmInferenceDevice`, and the state is visible on
`getNodeInferenceDevices` (the admin row reads `unavailable`), in the runner's
`inference device FAILED` line and in the orchestrator's `inference device
REFUSED by its executor` line.

## Consequences

- A device pool that dies costs at most `maxDeaths` (3) Python spawns inside the
  window (10 min) and is then off the balancer within two refresh ticks (~10 s).
- A frame in flight when a pool is condemned is now **rejected with a reason**:
  `PoolWorker.dispose()` runs `rejectAll` after terminating the child. It used
  to sit until its own 60 s deadline and then report "worker alive, no reply"
  about a process dead for a minute.
- A spawn that throws is now BACKOFF-GATED. The immediate retry that
  `engine-factory-single-flight.spec.ts` asserted is now refused by name; the
  rebuild happens after 500 ms. That test was updated, not deleted.
- The exclusion is a cap change, so it only reaches a node through a published
  `@camstack/server` (D16). Until then the operator lever is unchanged and
  immediate: set `enabled: false` on `openvino:gpu` in the hub's
  `inferenceDevices`, which drops it from the same eligible set by the
  `disabled` reason. That is a zero-code fix and it stops the rotation today.
- The format-keyed capability gate is untouched. This channel sits beside it —
  it cannot replace it, because a format gate answers a different question.
- Not addressed here: the model-index leak (`allocateIndex` consumes a slot per
  failed load; past 254 the pool can never serve again). That is why recovery
  must go through a factory REBUILD, never a retry in place —
  `2026-08-26-pool-not-initialized.md` §6.3.

## Enforcement

Tests, each verified load-bearing by disarming the fix and confirming red:

- `packages/addon-pipeline/src/detection-pipeline/engine/__tests__/inference-device-liveness.spec.ts`
  — the budget trips, the terminal state is published, the re-arm clears it, no
  success-based reset exists.
- `packages/addon-pipeline/src/detection-pipeline/__tests__/dead-pool-is-not-handed-back.spec.ts`
  — the corpse is not returned; **12 dispatches build 3 pools, not 12**.
- `packages/addon-pipeline-orchestrator/src/__tests__/inference-device-liveness-routing.spec.ts`
  — one bad read never excludes; a FAILED read changes nothing; two bad reads
  far apart do not add up; all-dead ⇒ node unusable, not CPU-demoted.
- `server/backend/src/__tests__/cap-routers/pipeline-executor.router.spec.ts` —
  an empty `unhealthy` and a rejection stay distinguishable at the wire.

No guard script: the properties are behavioural, and a static check could not
tell a correct fold from the subtly wrong one that shipped in the first draft of
this change (it observed only the refused devices, which silently broke
"consecutive"). The test that caught it is the enforcement.
