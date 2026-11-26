---
id: D1104
title: A camera's detection stream profile and rate follow a cluster default, set only by a confirmed plan
status: accepted
date: 2026-11-26
supersedes:
applies-to:
  - packages/types/src/pipeline/detection-defaults/**
  - packages/addon-pipeline-orchestrator/src/device-detection-settings.ts
  - packages/addon-pipeline-orchestrator/src/detection-defaults-service.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-settings-store.ts
  - packages/addon-pipeline-orchestrator/src/device-config-contributions.ts
---

## Context

`detectionStreamProfile` (`high`) and `detectionFps` (`10`) were per-camera code
constants, hydrated from the settings schema into every camera. A cluster of
CPU-only nodes therefore decoded every camera's main stream at 10 fps unless
the operator edited each camera, and nothing told the operator that a node
could not decode the 4K streams it served. The obvious fix, writing a better
value into every camera, was rejected: it turns a default into an override, so
the next change of mind has to touch every camera again and a camera the
operator really did pin cannot be told from one the tool pinned.

## Decision

A camera resolves each field as: its own stored value, then the CLUSTER
default kept in the pipeline-orchestrator settings (`clusterDetectionDefaults`),
then the code constant. `resolveDetectionSettings` is the only place that order
is written. A camera that stored nothing stays unset and follows the cluster
default; no save path writes the effective value into a camera.

The cluster default is suggested, never imposed. `planDetectionDefaults` reads
and writes nothing: it returns the rule-v1 recommendation
(`recommendDetectionDefaults`), the stored default, and the cameras that pin
either field (count and ids). `applyDetectionDefaults` recomputes the plan,
answers `stale` for a different `planHash`, and writes the cluster default
only, never a camera override. Nothing runs it automatically.

Rule v1, over the nodes that serve cameras only:
- every serving node CPU-only gives the `low` stream at no more than 5 fps;
- a node never suggests `high` when its measured 4K decode `maxStreams` is
  below the cameras it serves (it suggests `mid`);
- a mixed cluster is judged on its WEAKEST serving node;
- an unmeasured fact (`null`, D393) is no recommendation for that dimension,
  never a guess and never `0`. An unknown node blocks a recommendation above the
  floor, because it could be the weakest.

## Consequences

Changing the cluster default moves every unset camera: the apply re-resolves each running camera through the settings-save rebuild path (the cached attach config would keep the old values), and only when the stored default changed; cameras with an override do not move. A legacy stored `detectionFps: 0` is the camera's own value, so it counts as an override. The
camera form shows the cluster value for an unset field (display only). A UI that
submits the whole form on save would freeze the shown value into the camera: a
form must send only edited fields. The rule is a version: a later rule changes
the recommender, not the resolution order.

## Enforcement

Specs: `recommend.spec.ts` (every branch of the rule),
`device-detection-settings.spec.ts` (resolution order, legacy `0` fps),
`device-contribution.spec.ts` (an unrelated save leaves both fields unset),
`detection-defaults-service.spec.ts` (plan writes nothing, apply writes the
cluster default only). No guard checks that a future save path stays sparse.
