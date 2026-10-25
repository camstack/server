---
id: D792
title: The Benchmark page is Node benchmark, Image and Audio; the session replay, the capacity tab, the synthetic bench and the page's history are deleted
status: accepted
date: 2026-10-08
supersedes: D646 (the session replay and its stored runs; Sustained Throughput as a capacity-ramp tab)
applies-to:
  - packages/addon-benchmark/src/**
  - packages/addon-admin-ui/src/components/pipeline/auto-tune/auto-tune-view-model.ts
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterAutoTuneTab.tsx
  - scripts/check-replay-isolation.ts
---

## Context

The page had six tabs that answered six unrelated questions with
overlapping tools: a single run, a synthetic bench in three shapes, a
capacity ramp that could only reach the hub's runner, a session replay
against stored tracks, an audio test, and a history of hand-saved rows that
nothing read back. The operator asked one question of it — what can this node
carry — and no tab answered it for any node but the hub. The node benchmark
(D791) now answers it from the orchestrator, and its results are what Auto
tune and the shares read; a second place to keep or chart numbers would be a
second authority.

The session replay measured something real (does this model on this pool
still find what the camera stored), but nobody used it and the node
benchmark covers the capacity half; the operator chose to delete it rather
than relocate it.

## Decision

The page has three sections:

- **Node benchmark** — the plan editor for the orchestrator's node
  benchmark (node, devices and candidate detectors, measurements, detail
  steps, fps, time budget), its preflight shown in the confirmation (the
  cameras that move, those that cannot, the steps, the duration), the
  running state with Abort, and the node's stored results with their
  standing. The page holds only the operator's draft.
- **Image** — one run of a step tree on one image, to inspect what it finds.
- **Audio** — one classification of a reference sound.

Deleted: the session replay (its custom actions, its `benchmark:replay-runs`
store, its decoder), the capacity tab, the synthetic bench, the history
actions and their store. The addon keeps one custom action
(`runPipelineTest`). The Auto tune tab says per device whether its speed was
measured on the node or read from the table.

## Consequences

- Stored replay runs and history rows are no longer read; their collection
  and blob are left in place, unused.
- The runner's custom actions (`cacheBenchFrame`, `startSyntheticBench`,
  `runCapacityRamp`) and the executor's `replay` flag have no page caller
  left; they stay until a later cleanup removes them with their scripts.
- The Audio section is unchanged: its backend picker still does not reach
  `runAudioTest`, and a sound is still classified as one chunk.

## Enforcement

- `packages/addon-benchmark/src/node-benchmark/__tests__/plan-editor.spec.ts`
  — every editor choice reaches the plan; the confirmation names the node,
  the moving and staying cameras, the steps and the duration.
- `packages/addon-benchmark/src/__tests__/benchmark-actions.spec.ts` — the
  catalog is exactly `runPipelineTest`.
- `auto-tune-view-model.spec.ts` — the source line of a device.
