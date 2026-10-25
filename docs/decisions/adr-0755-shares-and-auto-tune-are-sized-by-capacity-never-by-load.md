---
id: D755
title: Shares and Auto tune are sized by capacity, never by load; the share source is hardware, benchmark or manual
status: accepted
date: 2026-10-07
supersedes: D745 (its demand model — observed 24 h peaks and the fixed estimate); D748 (Auto tune charging the cluster parallel peak × shares, and the what-if plan); D750 (the `auto` share source, now `hardware`)
applies-to:
  - packages/types/src/pipeline/auto-tune/**
  - packages/types/src/pipeline/load-balancing/**
  - packages/addon-pipeline-orchestrator/src/auto-tune/**
  - packages/addon-pipeline-orchestrator/src/load-balancing/**
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterAutoTuneTab.tsx
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterLoadBalancingTab.tsx
  - packages/addon-admin-ui/src/components/pipeline/load-balancing/**
  - packages/addon-admin-ui/src/components/pipeline/auto-tune/**
---

## Context

On 2026-10-07 the automatic shares gave the N100 **1 %** while `suggestShares`,
asked a minute later, said **6 %** (Mac 31 / hub 63). D750 says the automatic
shares ARE the suggestion, so one of the two was wrong. The hub log showed
why: the recompute ran on `node-online:agent-a`, before that node's
catalog answered, so the recommender skipped it (`node-offline`), its share
came back null, and the election read the missing weight as 1 (1 %). The
60 s reconcile only compares a topology signature (nodes, detect flags,
enabled devices, models) — a node becoming READABLE changes none of that — so
the wrong answer was held until the 15 min age bound, after every rejoin and
every hub restart. A second, latent path dependence made it worse: the
suggestion's first round overlaid the PREVIOUS effective shares, so a node
absent from them was charged no load.

Behind both sat the demand model of D745/D748: Auto tune and the automatic
shares charged load as the observed 24 h peak of parallel sessions (in
memory, so after a day of releases every device said `estimate`, observed
for ~9 min) or, failing that, a quarter of the on-motion cameras split by
shares — which, at a 1 % share, charged the N100 nothing. A durable
5-minute session history (p95 over 7 days) was designed and then dropped by
the operator: balancing must be simple and explainable without a week of
data.

## Decision

No load input anywhere in automatic shares or Auto tune — no observed peaks,
no estimate, no history. Both are sized by CAPACITY:

- **Auto tune** picks, per node, the most accurate YOLOv9 model (the existing
  order: most accurate, ties within 0.02 recall to the faster, so 640 steps
  down before 320) with which EVERY enabled accelerator sustains at least
  `minSessionsPerDevice` parallel sessions —
  `⌊fps × (1 − headroom) / camera fps⌋`, camera fps = the fastest camera
  running the pipeline root (10 when none). The floor is an operator option
  (default 2, 1–8) sent with the plan and the apply and covered by the plan
  hash. Every device's reason says `capacity N sessions ≥ min M`; when nothing
  reaches the floor, the model with the most capacity is used and said so.
- **The share source** is `hardware` (default), `benchmark` or `manual`.
  `hardware` = each node's capacity in sessions at its Auto tune models (at
  the defaults) from the latency table, device shares inside a node by fps.
  `benchmark` = the same from node benchmark results through
  `NodeCapacitySource`; a node whose results are missing (or cover only some
  of its sized devices) uses `hardware` and the answer says so per node. A
  stored D750 `auto` reads as `hardware`.
- **One computation**: `computeCapacityShares` is both `suggestShares` and the
  automatic shares, in one pass that depends on nothing but capacity.
  `EffectiveSharesService` also recomputes on the next 60 s reconcile when
  its answer skipped a node as not readable yet (`node-offline` /
  `no-hardware-facts`) or was computed for another source.

## Consequences

- `DevicePeakTracker`, `estimateDeviceDemand`, `DeviceDemand`, the
  `estimated-load` / `fits{utilisation}` reasons, `onMotionSource`, the
  what-if plan (`AutoTuneOptions.shares`, `plan.whatIf`) and the suggestion's
  `iterations` are deleted. `getPlacementStats` (actual shares, the 1 h
  cluster peak) stays — it describes, it no longer feeds a decision.
- On deploy, Auto tune at the defaults moves the N100 from `yolov9m-320-int8`
  to `yolov9s-320-int8` (m-320-int8 carries one 10 fps camera with 40 % kept
  free; the floor is two) — shown in the plan, applied only on confirmation.
  The automatic shares on this cluster become hub 42 / N100 17 / Mac 41
  (capacity 5 / 2 / 5 sessions), where D750 gave 63 / 6 / 31 from a
  demand-dependent model pick.
- The benchmark results store does not exist yet; the orchestrator wires
  `NO_MEASURED_CAPACITY`, so `benchmark` is selectable and every node says
  "no benchmark results yet — sized from hardware". The store implements
  `NodeCapacitySource.readMeasuredCapacity` and nothing else changes.
- The automatic shares use Auto tune's DEFAULT floor and headroom; an operator
  who applies Auto tune at another floor runs those models while the shares
  are computed at the default picks. Accepted for simplicity; revisit if the
  floor is ever persisted.
- A node that stays unreadable is recomputed every 60 s; an unchanged retry
  logs at debug, not info.

## Enforcement

- `packages/addon-pipeline-orchestrator/src/__tests__/effective-shares-service.spec.ts`
  — "an answer computed while a node was not ready yet is recomputed on the
  NEXT reconcile" (the live 1 % vs 6 %; red with the not-ready rule removed),
  the source passed to the suggestion, a source switch recomputing.
- `packages/types/src/pipeline/auto-tune/__tests__/recommend.spec.ts` — the
  floor, the step-down (640 before 320), the slowest accelerator limiting the
  node, camera fps, nothing reaching the floor.
- `packages/types/src/pipeline/load-balancing/__tests__/capacity-shares.spec.ts`
  — hardware shares, benchmark per node, the two fallbacks.
- `packages/addon-pipeline-orchestrator/src/__tests__/auto-tune-service.spec.ts`
  — the floor in the hash and the apply, one-pass suggestion equal on repeat,
  unreadable benchmark results falling back.
- Admin UI: `load-balancing-view-model.spec.ts`, `auto-tune-view-model.spec.ts`,
  `cluster-auto-tune-tab.spec.tsx`.
