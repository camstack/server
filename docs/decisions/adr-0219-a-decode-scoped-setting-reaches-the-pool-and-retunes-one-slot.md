---
id: D219
title: A decode-scoped step setting reaches the pool, and a change retunes ONE slot instead of reloading it
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/engine/pool-decode-settings.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pipeline-model-manager.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/shared-inference-pool.ts
  - packages/addon-pipeline/python/inference_pool.py
---

## Context

[D214](adr-0214-step-settings-are-model-scoped.md) audited every step knob
against every model and found one that applied to NOTHING: `nmsIouThreshold`.
The slider wrote `step.settings`, `PoolModelConfig` declared the field,
`serializeModelConfig` forwarded it, and `yolo.py` / `yolo_seg.py` /
`rfdetr.py` / `scrfd.py` all read it — every link existed except the one that
supplies a value. `PipelineModelManager` dropped `step.settings` on the floor
and its `buildPoolConfig(stepId, modelId)` had no parameter to carry it, so
`inputs.nmsIouThreshold` was `undefined` at every construction site and the
pool ran the 0.45 literal for two years of slider movement. The D62 class
verbatim: a control that writes a store nobody reads. D214 deliberately did not
fix it — the fix needs the threading AND a reload trigger — and left it as a
train-note.

The naive fix reintroduces a different failure. A settings change reaching
`applyConfig` means a `replace`, which is `unload` + `load` in the Python pool:
the session is re-instantiated (~1.4s on coreml, an OpenVINO recompile) and
every live camera on the node stalls, for a value the decode re-reads from
`slot.config` on every single frame anyway.

The second trap is scope. The manager's per-dispatch skip gate was
`isLoadedWithModel(stepId, modelId)` — a predicate that cannot see a changed
setting. Every warm pair (i.e. all of them, after the first frame) short-
circuited before the load path, so a saved threshold would still have reached
nothing.

## Decision

A decode-scoped setting — one the Python decoder re-reads from `slot.config`
per inference — is threaded from `PipelineDefaultStep.settings` to the pool,
and a CHANGE to it retunes exactly one slot without a reload.

1. **One derivation.** `resolvePoolDecodeSettings` (`pool-decode-settings.ts`)
   is the only place a `(step, model, settings)` triple becomes a
   `PoolDecodeSettings`. It is used by `buildPoolModelConfigForStep` for the
   value SENT in the `load`, and by `PipelineModelManager` for the diff that
   decides whether to retune. Two derivations drift, and a drifted diff means
   the pool keeps the old value while the manager believes it applied the new
   one. It is pure and **fs-free by contract**: the diff runs once per camera
   frame, where `buildPoolModelConfigForStep` (which reads the model's label
   file off disk) must never run. That is why `PoolModelSource` has two
   functions and not one.
2. **The diff is anchored to the command that was sent**, never re-derived:
   `LoadedStep.decode` is taken from the built config via
   `poolDecodeSettingsOf`.
3. **`reconfigure`, not `replace`.** A new pool command patches `slot.config`
   at ONE index with no session work, and refuses any key outside
   `RECONFIGURABLE_CONFIG_KEYS`. A `path` accepted there would sit in the
   config while the loaded session kept serving the old model — undetectable.
   The allow-list mirrors `PoolDecodeSettings`; adding a key on one side only
   recreates the dead-knob class this record closes.
4. **The skip gate is `needsPoolUpdate(step)`**, never `isLoadedWithModel` —
   at all four sites (`ensureModelsForSteps`, both benchmark filters,
   `loadAdditional`).
5. **Applicability is enforced at the runtime, not only in the UI.**
   `postprocessorConsumesNms` is exported from `model-knob-applicability` and is
   the single predicate behind BOTH the UI's disable-with-reason and this
   resolution. A fused-NMS model (`yolonas`, `ssd`) pins the fallback whatever
   the operator saved — the value is ignored, not pretended, and the slider
   does not churn the pool for nothing.
6. **A persisted value is validated as external data.** Only a finite IoU in
   the open `(0,1)` interval is forwarded; anything else falls back rather than
   reaching a decode where `0` suppresses every overlapping box and `1`
   suppresses none.

## Consequences

- **A pool slot is NODE-level, so per-camera variance in a decode-scoped knob
  is not expressible.** Two dispatches that disagree pull the same slot back
  and forth and one of them always decodes with the other's value. That is not
  silent: `PipelineModelManager.reportContention` warns ONCE per (step, model)
  the first time a pair flip-flops BACK to a value it already ran — the
  unambiguous signature of two writers, which a one-way operator retune never
  produces. It was observed live during verification and is the reason a
  per-camera override of this knob must not be encouraged.
- Any NEW knob whose value the decode re-reads per frame belongs in
  `PoolDecodeSettings` + `RECONFIGURABLE_CONFIG_KEYS` + this derivation.
  Anything the SESSION binds at load time (input size, normalization, the model
  path) does not — it needs `replace`, and putting it here would silently not
  take effect.
- `NMS_IOU_DEFAULT` now lives in `pool-decode-settings.ts`; `engine-factory`
  re-exports it. Two copies of that literal is exactly how a diff and a load
  command come to disagree.
- D214's consequence line ("`nmsIouThreshold` remains dead at runtime until the
  settings→pool threading is built") is discharged by this record.

## Enforcement

- `packages/addon-pipeline/src/detection-pipeline/engine/__tests__/nms-threshold-reaches-the-pool.spec.ts`
  pins the whole chain to the command sent to the pool: the value in
  `loadModel`, the single-index `reconfigureModel` on a change, no reload/no
  unload, idempotence, the log line, `needsPoolUpdate`, the fused-NMS
  ignore-without-churn, the contention report, and the invariant that
  `buildConfig` and `resolveDecode` never disagree. Removing the threading (in
  either the resolution or the manager) turns it red — verified both ways.
- `packages/addon-pipeline/python/test_inference_pool_reconfigure.py` pins the
  Python side: patch lands on the named index only, session object unchanged,
  a non-allow-listed key refused without half-applying, an unloaded slot
  refused, and the allow-list equal to `PoolDecodeSettings`.
- Live (2026-08-21, hub `openvino:gpu`, `yolov9m-320-int8`): a `runPipeline`
  carrying `nmsIouThreshold: 0.85` produced
  `Decode settings retuned in place — no model reload {previous: 0.45, next: 0.85}`
  and the worker's `Model 0 reconfigured: {'nmsIouThreshold': 0.45} ->
  {'nmsIouThreshold': 0.85}`; the same image decoded 4 boxes at `0.1` and 6 at
  `0.9`. The next live dispatch (which carries no setting) retuned the slot
  back to 0.45 on its own, and the contention warning fired exactly as
  designed.
