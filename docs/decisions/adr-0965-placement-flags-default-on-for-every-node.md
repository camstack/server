---
id: D965
title: Placement flags default on for every node
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/node-topology.ts
  - packages/addon-admin-ui/src/components/pipeline/lib/node-enablement.ts
---

## Context

A node's placement roles (detect, audio, ingest) were on by default only for
the hub; every other node needed an explicit stored `true`. A Mac agent that
was re-paired got a new node id and no stored settings, so it was excluded from
detection balancing: effective share 0 although its benchmark share was 49.5%.
The refresh also iterated only `hub` plus the keys of the stored blob, so an
agent with no entry was never even considered.

## Decision

A placement flag is ON unless the operator stored an explicit `false`, for every
node. The set of nodes the orchestrator evaluates is the hub, the stored nodes
and every node known to run pipeline-runner; an agent coming online re-derives
the enabled sets. The admin UI shows an unset flag as ON.

## Consequences

A fresh agent joins detection, audio and ingest balancing the moment it is
online. An operator who wants a node out turns the role off; a node with no
inference device is served by the runner's default pool and receives cameras
only in proportion to its configured share.

## Enforcement

`node-topology-default-on.spec.ts` (orchestrator) and `node-enablement.spec.ts`
(admin-ui).
