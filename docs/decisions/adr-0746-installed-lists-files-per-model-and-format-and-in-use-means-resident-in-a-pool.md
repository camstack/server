---
id: D746
title: Installed lists files per model and format, and "in use" means resident in a pool
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-model-studio/src/ui/installed-inventory.ts
  - packages/addon-model-studio/src/ui/installed-activation.ts
  - packages/addon-model-studio/src/tabs/InstalledTab.tsx
  - packages/addon-pipeline/src/detection-pipeline/model-format-facts.ts
  - packages/types/src/types/models.ts
---

## Context

Model Studio → Installed showed one card per model with a pill per device.
A pill was "active" when the catalog default for the device's format was this
model. It never asked whether the device was enabled, or whether the file was
on disk. On the live hub (2026-10-07) the CPU and the Coral are disabled, yet
`yolo26n` and the Coral SSD read "running on CPU / Coral". Their Remove was
hidden, because Remove was blocked on any active pill. Several other defects
came from the same card:

- Size was summed across formats. Remove deleted every format at once.
- A cluster-scoped model (face, CLIP) got a `cluster` pill. Clicking one of
  its device pills rewrote the cluster row.
- `downloaded: false` meant both "no copy" and "a copy not yet proven at its
  revision" (D743/D744). Nothing showed the build's precision.

## Decision

A row is a FILE on the selected node: one row per model × format. Its chips
are the node's devices of that format, so NPU and iGPU sharing one OpenVINO IR
are two chips on one row. Each chip answers two separate questions:

- **loaded**: the model is resident in that device's pool right now, from
  `pipelineExecutor.listLoadedEngines` (`stepId/modelId` in `modelsLoaded`).
  If that read fails, the answer is unknown, never "no".
- **configured**: the device is enabled, the file is current on disk, and the
  device's effective model for the step is this one
  (`acceleratorsRunningModel`, or the cluster row for a cluster-scoped step).

The row's usage is `in-use`, `configured`, `idle` (an enabled device could
run it), `unused` (no enabled device runs this format, so the space is
reclaimable), `outside-pools` (the audio analyzer's own process), or
`unknown`. Remove deletes one format and is offered only on `idle` and
`unused` rows. Cluster-scoped models get read-only chips and a Cluster models
section that shows, for each node, where the model runs: node · runtime ·
devices · loaded, or "no build for <format> → refused". The cluster row
changes only through that section's explicit action and its confirm.

`getSchema` reports two more facts per format (`PipelineModelFormatStatusSchema`).
`onDisk` is `current`, `stale` or `missing`; `downloaded` is
`onDisk === 'current'`. `precision` is `fp32`, `fp16` or `int8`, reported
only when the build states it: a file-name token, an INT8 variant, an EdgeTPU
compile, or a CamStack Core ML export (D743). An unsuffixed OpenVINO IR is
FP16 in one family and FP32 in another, so it reports none.

## Consequences

- Both new fields are optional. A runner older than this change reports only
  `downloaded`, and the page reads that as `current` or `missing`.
- The rule lives in `addon-pipeline`, not in `@camstack/system` or
  `@camstack/types`. Both are resolved from the host at runtime, so a new
  value there would make the addon fail to load on an older hub. Only the
  schemas, which are types, are in `@camstack/types`.
- The page reads every online node (getSchema, devices, loaded engines) for
  the Cluster models section.

## Enforcement

`installed-inventory.test.ts` and `installed-activation.spec.ts` cover a
disabled device, a missing file, two chips on one row, the unused and
unknown states, and per-node placement. `installed-tab.test.tsx` checks that
Remove deletes one format. `model-format-facts.spec.ts` covers on-disk state
and precision against the shipped catalog.
