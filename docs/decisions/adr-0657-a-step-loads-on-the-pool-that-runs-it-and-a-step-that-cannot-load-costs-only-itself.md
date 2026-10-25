---
id: D657
title: A step's model loads on the pool that runs it, and a step whose model cannot load costs only itself; a per-format default names a model with that build
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/pipeline-runner/device-jump.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
  - packages/addon-pipeline/src/detection-pipeline/provider.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/step-utils.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/addon-pipeline/src/__tests__/guards/format-defaults-buildable.guard.ts
  - packages/types/src/pipeline/step-format-runnable.ts
  - packages/addon-pipeline/src/detection-pipeline/step-resolution.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-resolver.ts
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
  - packages/addon-pipeline/src/shared/custom-model-catalog.ts
---

## Context

D650 shipped on 2026-09-27 (addon-pipeline 1.2.296, orchestrator 1.2.258).
From 09:22 to 09:36 the hub pool held `openvino:gpu`, `openvino:npu` and the
Coral (`edgetpu:usb`, tflite, whose only object model is an SSD). The balancer
elected "sala da pranzo", "hall", "kitchen" and "esterno garage" onto the
Coral. The runner did its part: `enrichment step runs on another device of
this node {step=face-detection electedDeviceKey=edgetpu:usb
targetDeviceKey=openvino:gpu reason=auto provisioned=true}`. Then every frame
failed: 687 `runInference failed` in those 14 minutes, all ending in
`Model "scrfd-2.5g" has no tflite format build`. The Coral was disabled again.

Three faults, each enough on its own to lose a model, stacked to lose the root:

1. **The frame plane carried a subtree the detail plane had jumped.** A
   frame-plane dispatch executes only root-plane steps; detail children ride
   it only so their models pre-warm the pool. The provider pruned a detail
   child from it only when its catalog had ZERO builds for the pool's format
   (`provider.ts:2989-2990` on `main`, `stepHasZeroBuildsFor` →
   `collectZeroBuildIssues`, `step-resolution.ts:141`). `face-detection` has
   one tflite build, the LEGACY Coral face SSD stub (no working
   postprocessor, excluded from every auto-pick), so it was kept. The runner
   judged the same subtree by a different rule (`buildSubtreeCanRun`, whole
   subtree) and jumped it. Two rules for one question, and they disagreed.
2. **The kept step resolved to a model with no build.** Unpinned
   face-detection on tflite resolved through `defaultModelIdByFormat.tflite =
   'scrfd-2.5g'` (`step-definitions.ts:589`). The catalog has no tflite SCRFD.
3. **One bad model poisoned the whole load.** The dispatch loaded its whole
   tree as ONE set (`provider.ts:2586`). The artifact check threw a plain
   `Error` for SCRFD (`provider.ts:3265`), and a plain error was charged to
   EVERY model of the set (`provider.ts:3294`). So the D653 negative cache
   backed off `object-detection/ssd-mobilenet-v2-coco-edgetpu`: `failed to load
   on edgetpu:usb 6 time(s); not retried for 32922ms (Model "scrfd-2.5g" …`.

## Decision

**A step's model loads only on the pool that runs it, decided by the same
placement that runs it. A step whose model cannot load is dropped from its
dispatch by name and charged alone; the root and the other steps run. A
`defaultModelIdByFormat` entry names a model that ships that build.**

1. **One decision source: `placeDetailStep`.** The runner builds the
   frame-plane tree with `stepsForElectedPool` (`device-jump.ts`). For every
   detail subtree (the first detail-plane step on a path, judged whole) it asks
   `placeDetailStep`, with the attach's roster and the live counts, which is
   exactly what the detail plane asks when it dispatches that subtree. The
   subtree rides the frame dispatch only when the answer is "no decision" (no
   elected device, a roster of one) or `no-jump`. `jumped` (auto or manual)
   and `no-candidate` leave it out. A jumped subtree's model then loads on
   the TARGET pool, with the target's provisioning (the D650 roster entry),
   when the detail plane dispatches it there. Nothing new pre-warms the
   target; the first detail dispatch pays the load, as it did before D650.
   Once per (camera, elected device, set left out) the runner logs `detail
   steps not loaded on the elected pool — they run elsewhere`.
2. **The provider's backstop asks the same predicate.** The frame-plane prune
   in `resolveStepsForDispatch` (for callers with no roster: an older runner,
   the capacity ramp, recovery passes) now prunes a detail subtree when
   `buildSubtreeCanRun(subtree)` says the pool's format cannot run it. That is
   the runner's own function, imported, not a copy. It prunes the subtree
   whole, at its top.
3. **"Can this format run this step" has ONE answer, and it ignores legacy
   builds.** `stepModelRunsOnFormat` (`@camstack/types`,
   `pipeline/step-format-runnable.ts`; fix round 1): true when the model the
   step NAMES ships the build, or when a NON-legacy model does. A legacy stub
   counts only when it is explicitly pinned. This is
   `getDefaultModelForFormat`'s own auto-pick rule, applied to placement. Every
   placement reads it:
   - the runner's jump (`buildSubtreeCanRun`), judging each candidate device
     with the model THAT device would run (its roster entry; the elected
     device runs the step as sent);
   - the executor's dispatch gates (`collectZeroBuildIssues`: the root gate,
     the whole-tree gate of a full-plane call, `assertStepsRunnable`, and the
     config-issue surfaces);
   - the orchestrator's provisioning gate (`addonHasCompatibleModel`) and the
     device election's root guard (`makeRootCapabilityGuard`), which calls it.
     The orchestrator's resolver is structure-only, so it asks with no named
     model. Its catalog (`PipelineModelOptionSchema`) already carries
     `legacy`, and `getSchema` omits legacy models anyway, so the schema
     needed no change.
   It lives in the bare `@camstack/types` entry, which both addons bundle
   (`self-contained` externals), so it travels with a `camstack deploy`.
4. **Per-step failure, and this is the choice between the two options: load
   per step, fail per step, drop the step, keep the dispatch.**
   `loadDispatchModels` loads each step needing a load as its own set, through
   the existing D653 path (joined, serialised per pool, backed off, refused by
   name), and never throws. `stepsSurvivingLoad` removes the failed steps and
   their descendants (they consume the failed step's output) from the tree the
   executor runs. The dispatch fails only when no root survives, and then it
   throws the root's own named error. That is the policy of a camera's LIVE
   dispatch only (a `deviceId`, not a replay). Every other call is
   ALL-OR-NOTHING (fix round 1): a replay runs exactly what it names or nothing
   (D56); a single-shot benchmark or a capacity ramp measures exactly the tree
   it was asked for. Any failed step fails the call with
   `DispatchStepsNotLoadedError`, which names every step that did not load.
   The benchmark batch keeps its whole-set load, which already throws. A step
   whose load failed takes its subtree with it: its children are never loaded
   (they would leave the dispatch with it). The failed step is dropped by
   INSTANCE, not by addon id. The per-camera line `model load for dispatch
   failed` gains `outcome: step-dropped | root-lost | call-failed`. Refusing
   the step with no load attempt was rejected: it needs a second "loadable"
   predicate next to the loader, and those two would drift exactly as the two
   placement rules did. The load itself, which fails fast and by name on a
   format mismatch, is the only judge.
5. **A failure is charged to the model it names.** The artifact check (format
   build, local custom model, download) throws `StepModelArtifactError` (step,
   model). `recordModelLoadFailure` and the per-camera report charge a named
   error to that model alone, as they already did for `StepVariantLoadError`.
   That also covers the whole-set path the benchmark batch still uses.
6. **Catalog.** `face-detection` has no `defaultModelIdByFormat.tflite`: no
   face detector ships a working tflite build, so there is no tflite default.
   Unpinned face-detection on tflite now resolves to `defaultModelId`
   (`yunet-2023mar`), which is unloadable there too. A face step never runs on
   a tflite pool: the placement jumps it. The guard
   `format-defaults-buildable.guard.ts` (a package test, D548) fails when any
   registered step, active or dormant, declares a per-format default whose
   model is absent from its catalog or ships no build for that format.

**The D653 negative cache and governor, after this change.** Both key on the
model (`step/model`) per pool. A jumped step's model is never offered to the
elected pool, so the elected pool records nothing about it. The target pool is
a different key. If a step's model fails ANYWHERE, only that model is backed
off: the load is its own set, and the error names it. The root's entry is
touched only by the root's own loads. `jumped-steps-load-on-target.spec.ts`
asserts `check(pool, …, [root]).kind === 'go'` after ten frames with a failing
step, on both the per-step and the whole-set paths.

## Consequences

- A Coral-elected session runs its SSD on the Coral and its faces, plates and
  CLIP on the node's OpenVINO pools. The face models are no longer pre-warmed
  anywhere before the first face dispatch reaches the target pool. That first
  dispatch pays the load, as every jumped dispatch already did.
- A camera whose detail step cannot load on its pool now keeps detecting, and
  its line says `step-dropped`. Before, it produced nothing and said the root
  failed. A step stuck in back-off costs one governor check per frame and
  issues no load. `Benchmark: models to load` names only loads that will be
  issued, so it is not repeated per frame.
- Behaviour change: an unpinned face-detection (with face-embedding off) on a
  Coral-elected camera now JUMPS. Before, the legacy stub made it look
  runnable and it failed on the Coral. A camera that pins the Coral face stub
  explicitly still runs it there, and still gets "person"-labelled face boxes
  until an `ssd-face` postprocessor exists.
- The frame dispatch is built per frame from `placeDetailStep`. That is a
  walk of a handful of steps plus one pass over the attached cameras for the
  load counts. The load counts cannot change the keep/leave verdict: `no-jump`
  does not read them, and a subtree at the capacity limit becomes
  `no-candidate`, which is also left out.
- A Coral-only node now gates face-detection OFF by name
  (`no-compatible-model`); before, the legacy stub kept it and it failed on
  the Coral. On a Coral whose GPU/NPU are at their cap, the runner's placement
  answers `no-candidate`. The frame dispatch then leaves the subtree out, and
  the detail dispatch sent at the Coral falls back to the node's own engine by
  the whole-tree gate. It never fails the root.
- A camera that pins the Coral face stub on a Coral-only node loses it: the
  structure-only resolver asks with no named model. The stub has no working
  postprocessor, so nothing of value is lost.
- The admin UI's matrices still test "any build" for display. They place
  nothing.
- Not changed: `DetectionWiringController.handlePipelineCameraUpdated` still
  hot-reloads a tree with no roster (D650's known follow-up). Such a camera's
  frame plane falls back to the provider's backstop (item 2), which is now
  correct on its own.

## Enforcement

Each fix was disarmed on its own and its test went red, then restored:

| Disarmed | Red |
| --- | --- |
| runner roster filter (`stepsForElectedPoolOf` not applied) | `elected-pool-loads-only-what-runs-there.spec.ts`: the Coral-elected camera and the manual-jump case (2 of 4) |
| provider prune back to the per-top "any build" rule | `jumped-steps-load-on-target.spec.ts` (the Coral loads a face model); `dispatch-capability-gate.spec.ts` (the frame-plane prune) |
| legacy builds counted again in the shared rule | `device-jump.spec.ts`: unpinned face-detection cannot run on tflite (round 0); `step-format-runnable.spec.ts` (round 1) |
| whole-set load restored on the dispatch | `jumped-steps-load-on-target.spec.ts`: the root runs without the step; the root is named when it is lost |
| artifact failure charged to the whole set | `jumped-steps-load-on-target.spec.ts`: the whole-set load charges only the failing model |
| `tflite: 'scrfd-2.5g'` restored | `format-defaults-buildable.spec.ts`: the checked-out catalog passes |
| the guard's no-build branch removed | `format-defaults-buildable.spec.ts`: the entry that shipped is refused |

`jumped-steps-load-on-target.spec.ts` drives the real provider, catalog,
resolution and model manager. Only the pools' `loadModel`, the network download
and the executor's `run` are faked. A Coral dispatch of the camera's full tree
loads exactly the SSD. A detail dispatch of the face subtree at `openvino:gpu`
loads the two face models there. Both calls succeed.

### Fix round 1

Each item was disarmed on its own and its test went red, then restored.

| Disarmed | Red |
| --- | --- |
| the all-or-nothing throw deleted (the reviewer's disarm, which had left 774 tests green) | `jumped-steps-load-on-target.spec.ts`: the replay AND the benchmark case |
| a benchmark treated as live (the policy asks "not a replay" only) | the benchmark case |
| the shared rule counts legacy builds | `step-format-runnable.spec.ts` (types) |
| `collectZeroBuildIssues` back to "any build" | the Coral + capped GPU/NPU fallback case |
| `addonHasCompatibleModel` back to "any build" | `pipeline-resolver.spec.ts`: Coral-only, face-detection skipped by name |
| children of a failed step still loaded | the failed-step case: face-embedding is never sent |
| failed steps dropped by addon id | the two-face-detection case |
| candidates judged with the elected provisioning | `device-jump.spec.ts`: the Coral takes a manual jump with its own pinned stub |
| the roster-of-one short cut removed | `elected-pool-…spec.ts`: no count of attached cameras for a roster of one |
| the round-0 dedupe (a key kept forever) restored | `elected-pool-…spec.ts`: Coral → GPU → Coral logs twice |

### Fix round 2

- **One rule over one catalog.** The orchestrator judged the schema, which
  merges custom models; the executor and the runner judged the static catalog
  alone. So a custom model with a tflite build, pinned on a Coral, read as
  "no build" there. Both now judge the static catalog MERGED with the
  `custom-model-registry` models (`shared/custom-model-catalog.ts`). This is
  one TTL-cached read, which the executor's model resolution already used,
  refreshed on each async boundary (`runPipeline`, `runPipelineBatch`,
  `runInference`, `runDetailSubtree`) and read synchronously by the gates.
  A failed read keeps the last snapshot.
- **The small-subject recovery pass names its camera.** It now sends its
  `deviceId`, so a failed load there is tagged with it. It is one root step,
  so the live partial policy changes nothing. An `image` dispatch runs no
  zone gate, so crop coordinates still never meet one. The camera's
  per-device detector overrides now apply to the pass, as they do to its full
  frame.

Disarmed, each red:
- the executor's gates on the static catalog → the custom Coral face case in
  `jumped-steps-load-on-target.spec.ts`;
- the runner's placement on the static catalog → the custom Coral face case
  in `elected-pool-loads-only-what-runs-there.spec.ts`;
- the recovery pass without `deviceId` →
  `small-subject-recovery-dispatch.spec.ts`.

## Verification on the live hub

**Passive, read-only**, after the release carrying this is installed and the
Coral is re-enabled in the pool. Cameras elected onto it are the ones to
watch.

```bash
# 1. The incident's signature. Expect 0 of each.
ssh unraid 'docker logs --since 1h CamStack 2>&1 | grep -c "has no tflite format"'
ssh unraid 'docker logs --since 1h CamStack 2>&1 | grep "runInference failed" | grep -c "edgetpu:usb"'
# 2. Which cameras are on the Coral, and that their faces left it. Expect one
#    "not loaded on the elected pool" line per Coral camera (steps include
#    face-detection), and one "enrichment step runs on another device" per
#    (camera, step, target).
ssh unraid 'docker logs --since 1h CamStack 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | grep -E "detail steps not loaded on the elected pool|enrichment step runs on another device" | tail -40'
# 3. What the Coral pool loaded. Expect only ssd-mobilenet-v2-coco-edgetpu.
ssh unraid 'docker logs --since 1h CamStack 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | grep "Loading step variant" | grep "edgetpu:usb" | grep -oE "modelId=[^ ]+" | sort | uniq -c'
# 4. Any step dropped by name, and whether a root was ever lost. Expect none;
#    a step-dropped line is one per (camera, model, state change), never per frame.
ssh unraid 'docker logs --since 1h CamStack 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | grep "model load for dispatch failed" | grep -oE "(\[[^]]*\]).*(outcome=[a-z-]+)" | tail -20'
```

Expected on a healthy hour: counts 0 and 0 in (1); (3) shows only the SSD on
`edgetpu:usb`; (4) is empty. A `root-lost` on `edgetpu:usb` is the SSD itself
failing, and D653's lines name why. `runInference failed` for other reasons
(`stale-ref`, a worker `SIGSEGV`) is unrelated and was present before.
