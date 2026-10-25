---
id: D760
title: The load report credits a single-device node's default-pool sessions to its device; the census stays raw
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/agent-load-service.ts
  - packages/addon-pipeline-orchestrator/src/default-pool-attribution.ts
  - packages/addon-admin-ui/src/components/pipeline/node-load-model.ts
---

## Context

Load balancing → Node load showed the Mac "1/1 attached" and "0 sessions" on
its only accelerator (`coreml:all`). The live `getAgentLoad` carried
`devices: []` for the Mac and for agent-a, each with cameras attached.

The runner counts `RunnerLocalLoad.devices` by each camera's `deviceKey`. On a
node with exactly one eligible device the balancer leaves `deviceKey` unset
(`single-eligible-device`) and the runner's default pool serves the camera, so
the runner attributes it to no device. The UI then read the missing entry as
`?? 0`. D745 already settled that this default pool IS the node's one device for
provisioning, and chose not to invent a `deviceKey` for the runner.

## Decision

`getAgentLoad` (the report) credits a node's unattributed sessions
(`attachedCameras` minus the per-device sum) to its eligible device when the
node has exactly one, read from the cached eligibility (no call to the node).
With several eligible devices, or an unknown eligible set, nothing is
attributed. The balancer's census (`collectAgentLoad`) stays the runner's raw
answer. The UI reads a device absent from the snapshot as 0 only when every
attached session is attributed; otherwise, or when the node did not report, the
count is unknown and renders "—".

## Alternatives rejected

- **Send the `deviceKey` to the runner on a single-device attach.** D745
  rejected it: it changes which pool the runner routes to, for a display fix.
- **Attribute in the census too.** The device balancer only reads per-device
  loads when there are two or more eligible devices, where nothing is
  attributed anyway. The one case it would change is a pin on a single-device
  node checked against `maxSessions`, which is a balancing change with its own
  consequences, not part of this fix.
- **Attribute in the UI.** The UI would have to repeat the server's eligibility
  rule. It still applies the weaker rule (absence is 0 only when everything is
  attributed), so a node the server cannot attribute shows "—", not 0.

## Consequences

- On a single-device node a pinned camera (keyed) and a default-pool camera
  (unkeyed) are summed on the same device in the report and counted separately
  in the census.
- A default-pool session on a multi-device node (`pin-unplaceable`,
  `all-devices-at-cap`) makes every absent device of that node read "—" until
  the session ends.

## Enforcement

`default-pool-attribution.spec.ts` pins the attribution and the raw census;
`node-load-model.spec.ts` pins "—" for an unreported node and for unattributed
sessions, and 0 only when every session is attributed.
