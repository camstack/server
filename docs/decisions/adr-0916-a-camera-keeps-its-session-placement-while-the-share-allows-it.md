---
id: D916
title: A camera keeps its session placement while the share allows it
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/types/src/pipeline/load-balancing/share-election.ts
  - packages/addon-pipeline-orchestrator/src/session-affinity.ts
  - packages/addon-pipeline-orchestrator/src/session-share-placement.ts
  - packages/addon-pipeline-orchestrator/src/device-balancer.ts
---

## Context

Amends D913 (the election memory) and D912 (a Coral takes a share like any
accelerator). Every on-motion session (10–20 s) was a fresh election, and at
election time nothing runs, so the decayed election memory rotated the camera
ON PURPOSE: that is how sessions that never overlap follow the weights. The
device tier also refused any stickiness, because an unconditionally sticky
device had frozen a camera onto one accelerator before. Measured on prod
(2026-10-23): camera 3835 ran 14 sessions in 10 minutes and moved node 11
times, across all four nodes; 637 moved 10 times in 12. Every move costs a
stream dial, a decode-worker fork and a pre-roll on a cold node.

Unconditional stickiness was rejected again for the reason it was rejected
first: it starves the other candidates, and a busy camera alone can raise more
sessions than one node's share. A per-camera fixed home was rejected because
camera rates differ by an order of magnitude and the shares count sessions,
not cameras.

## Decision

Each camera's last session placement (node and device) is remembered for the
election memory's own 30 minutes (`SessionAffinityMemory`). Under the `share`
policy, with no pin, the election (`electByShareWithAffinity`) keeps that node,
then that device, while it is offered (online, eligible, the device enabled and
available — a device in backoff is not offered), has room (not capped, not
drowning), and its deficit is within ONE session of the turn holder's. Otherwise
the plain share election decides. A kept session counts toward its candidate
exactly like any other, so no candidate runs more than about one session over
its share before its cameras leave, and the cumulative split still follows the
weights. A placement whose device refused the camera root is forgotten.

The dispatch line (`detection session: dispatched on motion`) carries
`sticky`, `stickyReason`, `previousNodeId`, `turnKey`, `recent` and `running`;
the `inference device selection` line carries the same for the device tier.

## Consequences

- Moves fall to about a third (simulated: 338 → 126 of 400 sessions over six
  cameras of uneven rates on four equal nodes, the split 100/101/100/99). A
  camera that raises more sessions than its node's share must still move: the
  busiest one in that trace (40% of all sessions against a 25% share) kept its
  node for two sessions in three. A tolerance of two sessions would cut moves
  to ~18%, at a coarser split; one was chosen, and the constant is
  `SHARE_AFFINITY_TOLERANCE_SESSIONS`.
- In memory and advisory: a restart costs one fresh election per camera.
- `least-loaded`, node pins and device pins are untouched.

## Enforcement

`share-affinity.spec.ts` (types: kept within one session, moved beyond it,
never kept when not offered, capped or drowning); `session-affinity.spec.ts`
(orchestrator: a 400/800-session trace — few moves AND each node within 15% of
its target share, for equal and unequal weights; TTL; the device tier);
`session-dispatch-share-placement.spec.ts` (the controller keeps a camera on
its node across sessions and logs `sticky` — red with the wiring removed).
