---
id: D961
title: An alert action may invoke an addon custom action; a skewed placement is suggested, not auto-corrected
status: accepted
date: 2026-10-28
supersedes:
applies-to:
  - packages/types/src/capabilities/alerts.cap.ts
  - packages/addon-admin-ui/src/components/ui/AlertActionLink.tsx
  - packages/addon-pipeline-orchestrator/src/rebalance-suggestion.ts
  - packages/addon-pipeline-orchestrator/src/placement-service.ts
---

## Context

When a node is paired or unpaired the pipeline does not always rebalance by
itself. The 60 s auto sweep migrates only when the target is at least 1.5
weight-adjusted cameras less loaded than the camera's current node, so a smaller
skew persists forever. Lowering that hysteresis was the first idea; it churns
live streams (a one-camera gap just reverses on the move). The operator wants to
be told, and to fix it in one click.

An alert action was a link only (`href`), so "click to rebalance" had nowhere to
go, and a hand-written route per producer would put addon knowledge in the UI.

## Decision

`AlertAction` carries `href` OR `invoke: { addonId, action, input? }`. The admin
UI renders `invoke` as a button that calls `addons.custom` with exactly those
fields and refreshes the alerts; it knows no addon and no alert kind.

The orchestrator raises `pipeline-orchestrator:rebalance-suggested` after one
debounced (90 s) evaluation following a node joining, leaving or changing its
roles. It plans a manual rebalance (margin 0) and the sweep's own plan (margin
1.5) with the SAME decision loop (`rebalance({ dryRun: true })`); only a camera
the manual plan moves and the sweep would not triggers the alert, and an empty
plan closes it. Its action is the custom action `rebalanceNow`, which runs the
manual rebalance and closes the alert. A separate `info` alert names an online
runner node that is not detect-enabled.

## Consequences

The sweep's hysteresis is unchanged: nothing moves a live stream unasked. The
plan and the act share one loop, so a suggestion cannot promise a move the click
will not make. The evaluation reads in-memory state only; a failed plan leaves
the alerts as they are (D49). The not-used alert set is kept in memory, so after
a hub restart a stale one closes only when its node is seen again.

## Enforcement

`rebalance-plan.spec.ts` (plan equals act), `rebalance-suggestion.spec.ts`
(raise, close, debounce, failed plan) and `AlertActionLink.spec.tsx` (invoke
renders and calls `addons.custom`).
