---
id: D498
title: A node sweeps only the cameras it analyses — the stationary table is shared, the judgement is local
status: proposed
date: 2026-09-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts
---

## Context

On 2026-09-14 the duplicate-collapse for device 102 was logged by
`MacMiniAgent.localdomain` AND by `agent-a` — the same rows, the same
entry ids, seven seconds apart.

Every node of the cluster runs `pipeline-analytics`, `StationaryObjectRegistry.
load()` hydrates the whole shared `pipeline-analytics:stationary-objects` table
into `idsByDevice`, and `sweep()` then walked EVERY hydrated device. So a node
that has never seen a frame of a camera was judging that camera's rows — with a
local view — and mutating them.

The TTL pass was already safe, by accident: expiry counts OBSERVED time, and a
device with no `noteFrame` has no observed clock, so the pass skipped it. The
collapse pass (D495) had no such guard and ran for every device on every node.

This is the same defect, on the same kind of shared table, that the summary
sealer took one day earlier (`summary-sweep-scope.spec.ts`, 2026-09-13): camera
101's summaries were being sealed by three nodes at once.

## Decision

The stationary sweep — TTL retirement AND duplicate collapse — acts only on the
cameras this node analyses. The ownership signal is the registry's own observed
clock (`noteFrame`): a node receives inference frames for the cameras it
analyses and for no others, and the clock is never cleared per device, so an
idle camera stays ours and a camera we have never framed never becomes ours.
Skipped devices are counted and reported at `debug` — another node owns them, so
this is not dropped work.

What this deliberately is NOT: a per-camera node assignment. `addon-post-
analysis` has none. Post-processing is a cluster singleton chosen by
`postProcessingNodeState`, which is not visible inside the registry and says
nothing per camera. A node that analyses nothing observes nothing, so the
predicate answers `false` for every row it hydrated — the outcome the singleton
would have produced anyway.

## Consequences

- A camera nobody analyses is never swept. Its rows persist until a node picks
  it up, which is correct: nothing knows anything about it.
- `load()` still hydrates the whole table. Reads (`list`, `listViews`,
  `deviceIds`) are unchanged and remain available on every node; only MUTATION
  is scoped.
- After a restart the owned set fills as frames arrive — within a second for a
  live camera — so the first sweep after a respawn may skip a camera that is
  about to be framed. It is picked up on the next tick.

## Enforcement

`pipeline/stationary/__tests__/stationary-sweep-ownership.spec.ts`: one sweep,
two cameras, only the framed one collapses; and an unanalysed camera is not
retired on TTL either.
