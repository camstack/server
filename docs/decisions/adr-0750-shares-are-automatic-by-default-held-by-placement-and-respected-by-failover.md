---
id: D750
title: Shares are automatic by default, held by placement, respected by failover, and follow every topology change
status: accepted
date: 2026-10-07
supersedes: D748 (only its "least-loaded stays the default"); Best settings is renamed Auto tune (D745 naming only)
applies-to:
  - packages/types/src/pipeline/load-balancing/effective-shares.ts
  - packages/types/src/pipeline/load-balancing/schemas.ts
  - packages/addon-pipeline-orchestrator/src/load-balancing/**
  - packages/addon-pipeline-orchestrator/src/node-stress.ts
  - packages/addon-pipeline-orchestrator/src/node-stress-controller.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-settings-store.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterLoadBalancingTab.tsx
---

## Context

D748 made share placement possible but kept `least-loaded` the default and the
shares manual: the operator had to press "Suggest from hardware", apply the
result, and remember to redo it whenever the cluster changed. On this hub the
stored sliders (Mac 70 / hub 20 / N100 10) were far from the measured capacity
(≈ 45 / 46 / 9), and nothing moved them when a device was switched off or Auto
tune changed a model. Two further gaps:

- Stress failover chose "the `ok` node with the fewest cameras". Under share
  placement that undoes the balance the next session election restores — the
  two would fight.
- Making `share` the default exposed a latent bug: the dispatcher's load
  census is memoised, so for a few seconds after a node LEFT it is still a
  candidate. `least-loaded` happened to steer away from it on its stale
  attached count; a share election handed the idle departed node the session
  and the dispatch failed ("Node … is offline").

## Decision

Placement holds the shares by default (`sessionPlacement: share`), and the
shares are AUTOMATIC by default (`shareSource: auto`): each node's and
device's share is the cluster's measured capacity at the Auto tune models
(`suggestShares`), recomputed at once when a node joins or leaves, a node's
detection or a device is switched, Auto tune changes a model, or the source
goes back to automatic — and on a 60 s reconcile that compares a topology
signature, with a 15 min age bound, because those triggers are events and may
be lost (D8, D49). `manual` applies the operator's sliders. In both, a node or
device that cannot take sessions simply is not a candidate, so the others split
its share in proportion; the stored values are never rewritten for that.
Every reader — both balancers, the share election, stress failover, Auto tune —
reads the same effective shares. Failover under share placement moves a camera
only to a healthy node below its share (largest deficit first) and holds,
naming the camera, when none is. The share election offers only nodes the
topology still knows. "Best settings" is called **Auto tune** in code, caps and
UI.

## Consequences

- On deploy the cluster switches from least-loaded to share placement with
  automatic shares. Until the first automatic answer arrives (the first
  suggestion needs every node's catalog) the stored sliders apply and the tab
  says so.
- Automatic shares are not persisted: a hub restart recomputes them, and the
  recompute is logged per node with the shares before and after.
- Switching to manual seeds the sliders with the current automatic shares in
  one write, so nothing jumps.
- A sliders-only change never triggers a recompute (it does not change
  capacity); the topology signature deliberately leaves sliders and caps out.
- Stress failover still runs only in `failover` mode; `observe` (the default)
  logs the verdict and the rule it would apply.
- `planBestSettings` / `applyBestSettings` are gone; the admin UI is their only
  caller and was renamed with them.

## Enforcement

- `packages/types/src/pipeline/load-balancing/__tests__/effective-shares.spec.ts`
  — the defaults, auto vs manual, redistribution without rewriting the stored
  values.
- `packages/addon-pipeline-orchestrator/src/__tests__/effective-shares-service.spec.ts`
  — recompute on a trigger, the reconcile catching a missed one (removing the
  signature comparison turns it red), the age bound, failures keeping the last
  answer, per-node logging.
- `packages/addon-pipeline-orchestrator/src/__tests__/node-stress-share-failover.spec.ts`
  — largest deficit, never a stressed node, hold naming the camera.
- `packages/addon-pipeline-orchestrator/src/__tests__/standing-machinery-on-motion-scope.spec.ts`
  — now under share placement by default: it went red until the election
  stopped offering a departed node.
- `packages/addon-pipeline-orchestrator/src/__tests__/auto-tune-service.spec.ts`
  — devices charged by the effective device shares.
