---
id: D1095
title: A camera dwells on its node for a minimum time before the share may move it
status: accepted
date: 2026-11-24
supersedes:
applies-to:
  - packages/types/src/pipeline/load-balancing/share-election.ts
  - packages/addon-pipeline-orchestrator/src/session-affinity.ts
  - packages/addon-pipeline-orchestrator/src/session-share-placement.ts
---

## Context

D916 keeps a camera on its previous node while that node's deficit is within
one session of the turn holder's. The recency history behind the deficit is
shared by every camera, and every election (kept ones included) adds to it. With
five or more on-motion cameras, one other camera's election pushes the previous
node more than one session off, each motion edge opens a short session, and the
next edge re-elects: board issue 672 saw one camera move little to hub to mac to
hub within two minutes, each hop a stream dial and a cold pre-roll.

## Decision

Amends D916. A camera that arrived on its node less than
`SHARE_AFFINITY_MIN_DWELL_MS` (10 minutes) ago keeps that node on a `share-off`
verdict, reported as `within-dwell`. The election stays pure: the arrival time
and now are inputs, taken from `SessionAffinityMemory` (`sinceMs`, kept while the
camera stays on the same node). An ineligible, full or offline previous node
still moves the camera at once; after the dwell the tolerance rule applies
unchanged. Only the node tier passes a dwell; the device tier is unchanged.

## Consequences

A node can run more than one session over its share for up to ten minutes per
arriving camera; the split converges once dwells expire.

## Enforcement

`share-affinity.spec.ts` (pure rule) and `session-dispatch-share-placement.spec.ts`
(five-camera replay, fails with the dwell at 0).
