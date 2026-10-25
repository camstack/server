---
id: D748
title: A share is a share of PARALLEL sessions, held at each session start; least-loaded stays the default
status: accepted
date: 2026-10-07
supersedes: D37 (the constant node order on the session path, under the `share` policy only)
applies-to:
  - packages/types/src/pipeline/load-balancing/**
  - packages/addon-pipeline-orchestrator/src/session-share-placement.ts
  - packages/addon-pipeline-orchestrator/src/session-placement-stats.ts
  - packages/addon-pipeline-orchestrator/src/load-balancing-shares.ts
  - packages/addon-pipeline-orchestrator/src/stale-device-pins.ts
  - packages/addon-pipeline-orchestrator/src/device-balancer.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterLoadBalancingTab.tsx
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterRolesNodesTab.tsx
---

## Context

The node and device weight sliders did not do what they showed. The balancer
scores a node `attached / weight`, so an empty node scores 0 whatever its
weight, and at a tie D37's constant node order wins. Every camera on this
cluster is on-motion and sessions rarely overlap, so almost every election was
a tie between idle nodes. Measured over 18 h (5 000 elections), with weights
Mac 70 / hub 20 / N100 10, the sessions split 51.7 / 32.3 / 16.0 — the N100,
about 4.5 % of the cluster's measured capacity, carried 16 %. The device tier
had the same flaw: its round-robin splits a tie 1:1 regardless of weight. The
weights only bite once a node already holds a session.

The knobs were also scattered: the sliders sat under roles, the events folder
and node capabilities on a "Balancer" tab; the low-fps toggle existed twice;
the policy fields lived on Settings; `maxCameras` had no editor; Best settings
(D745) ignored the node weights and read a camera-settings `pinnedAgentNodeId`
that nothing ever wrote. A live stale pin (camera 3836 → a disabled Coral) had
been ignored silently for 127 sessions — and, because it was set, it also
bypassed the single-device default pool on the Mac and the N100.

Rejected: "weight the score better" (any `attached / weight` form ties at 0);
"time-decayed placement history" (needs a decay constant; a wrong one
reintroduces the bias); a share of session STARTS or of session-seconds × fps
(the operator: what matters is the number of PARALLEL sessions).

## Decision

A cluster policy `sessionPlacement` (`least-loaded` | `share`) decides how a
new detection session picks its node and device. `least-loaded` is the
default and is exactly the old behaviour, so nothing changes on deploy; moving
a slider never flips the policy.

Under `share`, at each session start the node with the largest deficit
`share_i / Σshare × (Σrunning + 1) − running_i` wins (equal up to float noise →
the higher share, then a fixed order), where `running` counts the node's
parallel sessions and standing always-on cameras, each camera once. An empty
cluster sends the first session to the highest share; ten parallel sessions
settle at 7 / 2 / 1 for 70 / 20 / 10. A node pin (L1) still wins and its
session counts toward its node. The same election, with the device weights,
picks the device inside the node (instead of the 1:1 tie rotation).

Work-conserving: a candidate at an EXPLICIT cap (`maxCameras` / `maxSessions`)
or drowning (pool at its shed cap) yields its turn to the free candidate with
the most spare explicit room, then the largest deficit — never to a drowning
one; the yield is logged with the reason and counted. A capacity derived from
the measured latency table is ADVISORY: it is shown as a suggested cap with a
one-click apply and never enters the election, because a soft signal that can
refuse a session is a hard cap the operator never set.

Shares are written in ONE read-modify-write of the agent settings
(`setLoadBalancingShares`), which replaces `setAgentDetectWeight` and its N
racing per-node writes. Placement statistics (time-weighted share of parallel
sessions, starts, peak, yields, the cluster's parallel peak, stale device pins)
are kept in memory on the hub. Under `share`, Best settings charges on-motion
load as the cluster-wide 24 h parallel peak × node share × device share, so a
share change re-plans at once; it reads the live node pin (`pipelineNodeId`),
and `pinnedAgentNodeId` is retired. A device pin naming a device the elected
node does not offer is ignored and said once; it is listed for a one-click
clear, never cleared automatically.

## Consequences

- With `share`, a slow node gets its share even while a fast one is idle —
  that is the operator's choice; the hardware suggestion (shares ∝ measured
  capacity at the Best-settings models, ≤ 3 rounds to a fixed point) and the
  advisory caps are how to choose shares that do not drown a weak node.
- The drowning signal (`inFlight` / `inFlightCap`) is not reported by any
  runner today (`RunnerDeviceLoad` carries neither), so in practice a share
  turn yields only at an explicit cap. The election already honours the
  signal the moment a runner reports it.
- Statistics and the cluster peak are in memory: a hub restart starts a new
  window, and Best settings falls back to the fixed estimate, split by share.
- Node stress (`failover`) still moves a camera to "a node with strictly fewer
  cameras", ignoring shares; it is in `observe` on this hub. Revisit before
  combining `failover` with `share`.
- A share of 0 on the slider is stored as 1: the store and both policies read
  a non-positive weight as "unset ⇒ 1".

## Enforcement

Tests, each proven red with its rule removed: the election
(`share-election.spec.ts`: empty cluster, 7/2/1, pins counting, yields, float
ties), the node tier and running count (`session-share-placement.spec.ts`), the
session path end to end (`session-dispatch-share-placement.spec.ts`: least-loaded
unchanged, 70/20/10, capped yield logged and counted, stale pin said once and
ignored, stats fed), the device tier (`device-balancer-share.spec.ts`), the
share write (`load-balancing-shares.spec.ts`), the stats
(`session-placement-stats.spec.ts`), the cluster peak series, the demand split
(`demand-shares.spec.ts`), the suggestion and what-if
(`auto-tune-service.spec.ts`), stale pins (`stale-device-pins.spec.ts`), and
the tab's view model and wiring (`load-balancing-view-model.spec.ts`,
`cluster-detail-tabs.spec.tsx`). The method-tier baseline pins the three new
admin methods.
