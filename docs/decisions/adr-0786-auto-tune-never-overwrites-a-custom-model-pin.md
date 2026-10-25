---
id: D786
title: Auto tune never overwrites a custom model pin — the device, its group and a canary camera are kept
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/pipeline/auto-tune/recommend.ts
  - packages/types/src/pipeline/auto-tune/plan-schemas.ts
  - packages/addon-pipeline-orchestrator/src/auto-tune/plan-diff.ts
  - packages/addon-pipeline-orchestrator/src/auto-tune/auto-tune-service.ts
  - packages/addon-admin-ui/src/components/pipeline/auto-tune/auto-tune-view-model.ts
  - packages/types/src/pipeline/auto-tune/__tests__/recommend-custom-pin.spec.ts
  - packages/addon-pipeline-orchestrator/src/__tests__/auto-tune-custom-pin.spec.ts
---

## Context

Auto tune (D745) picks a catalog YOLOv9 model per node and its Apply REWRITES
`inferenceDevices[device].steps['object-detection'].modelId` on every touched
node, removes model-bound thresholds, and clears camera detector overrides.
The cloud-training plan registers fine-tuned roots in the custom-model
registry and canaries them by pinning a device or a camera (D208). One Apply
would silently replace a canary with a catalog model and erase its floors —
the canary's week of evidence would then describe a model that no longer
runs. The plan lists this as a hard prerequisite of any canary (P7).

Considered and rejected:

- **Perf rows for custom models**, so the recommender can rank them. Needs a
  measured latency per hardware class for every fine-tune; later, maybe. Today
  nothing measures them.
- **Warn only, still overwrite.** The operator confirms a list of dozens of
  writes; a warning in that list is how a canary gets lost.
- **Keep only the pinned device.** The accelerators of a node share one model
  so a camera's floors never flip with the device it rotates onto (D745);
  tuning the sibling would break that.

## Decision

**A device whose root detector is pinned to a custom-registry model is KEPT —
no model is chosen and the diff writes nothing on it; one kept accelerator
keeps the node's whole accelerator group; a camera override pinning a custom
detector is kept with its thresholds and its per-camera detector thresholds
are not cleared. The plan warns about each.**

- "Custom" is the registry's answer (`customModelRegistry.listModels`). When
  the registry does not answer, every pin outside the measured catalog
  (`DETECTOR_ACCURACY`) is treated as custom and the plan says so — unknown
  is never "not custom".
- Every stored custom pin is kept, enabled or not: its thresholds belong to
  the fine-tune.
- Capacity shares (D755) ignore custom pins: capacity is a property of the
  hardware.

## Consequences

- A node running a fine-tune is outside Auto tune until its pin is removed by
  hand (or a later rollback action does it).
- A canary keeps its exact configuration across any number of Applies.
- The plan hash covers `kept`, so a pin added between plan and Apply makes
  the Apply answer `stale`.

## Enforcement

`recommend-custom-pin.spec.ts` (the recommender keeps the device and its
group), `auto-tune-custom-pin.spec.ts` (the diff leaves a kept device, a
camera override and a wholesale snapshot byte-identical) and the
`custom models (D786)` block of `auto-tune-service.spec.ts` (plan, warnings,
Apply, detector thresholds, unreadable registry).
