---
id: D914
title: Node stress handling defaults to failover; its guards, not the mode, bound the churn
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/node-stress-controller.ts
  - packages/addon-pipeline-orchestrator/src/settings-ui-schemas.ts
---

## Context

`nodeStressMode` shipped as `observe` (D750 keeps the verdict aware of shares; the
design is in `docs/architecture/inference-devices.md`, "Node stress") on one
argument: the thresholds were reasoned, not measured on this fleet, and a
failover tuned from a guess is the flapping the guards exist to prevent. The
mode was a measuring instrument, not a policy.

The measurement now exists. The verdict is recorded as the `node-score` series
(device-history, 5-minute buckets, D850). Over the 2.5 days on the production
hub, a bucket whose peak reached the saturation score (0.8) was 1.7 % of the
hub's buckets, 2.2 % of the N100's, 0.6 % of the agent-b node's and 0.1 % of
the Mac's, and no node's bucket MEAN ever reached it. The operator wants the
balancing automatic, and an unwatched fleet cannot be asked to flip a setting
after reading a log.

Rejected: keeping `observe` and telling the operator to switch. A default that
never acts makes the feature a log line for everyone who does not read the
log, and the evidence that justified `observe` is gone.

## Decision

`nodeStressMode` defaults to `failover` (the code constant
`DEFAULT_NODE_STRESS_MODE` and the schema default agree). The three options
stay; `off` and `observe` remain one click away. The mode stays safe by its
guards, not by being off: one camera at a time, a per-camera cooldown, no return
to the node a camera just left, 4 moves an hour cluster-wide, and a camera is
never paused.

## Consequences

- A cluster that never stored the setting starts acting on its next
  orchestrator restart. A cluster that stored `observe` explicitly is not
  changed; the settings API reports the default as the value, so a stored value
  cannot be told from the default through it.
- A node that is saturated most of the time would now churn up to the
  4 moves/hour cap instead of logging. The 4/hour cap and the 30-minute
  return ban are what bound that; if a fleet shows it, the lever is the
  thresholds or `off`, not a different default.
- The `observe` rationale in `node-stress-controller.ts` and in the
  architecture page is rewritten: `observe` is a diagnostic, not the shipped
  behaviour.

## Enforcement

`node-stress-controller.spec.ts` ("an unset or unrecognised mode resolves to
failover"). The guards themselves are pinned by `node-stress.spec.ts` and
`node-stress-share-failover.spec.ts`.
