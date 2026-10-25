---
id: D913
title: Balancing is automatic — a new device is measured and the shares follow the live hardware
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/load-balancing/share-inputs.ts
  - packages/addon-pipeline-orchestrator/src/node-benchmark/auto-benchmark.ts
  - packages/addon-pipeline-orchestrator/src/share-election-history.ts
  - packages/types/src/pipeline/load-balancing/share-election.ts
---

## Context

The operator asked that balancing take minimal input. Three gaps made it
manual in practice:

1. `shareTopologySignature` was built from STORED agent settings only. A
   hot-plugged device with no stored entry (devices default to on) or an
   unplugged one changed nothing in it, so the automatic shares were not
   recomputed until a node event or the 15-minute age.
2. A node benchmark never started on its own (`startNodeBenchmark` was an
   admin RPC), so a new node or device sat on the hardware table until someone
   measured it, although the default share source is `benchmark`.
3. Share elections were memoryless. On-motion sessions rarely overlap, so each
   election saw all-zero running counts and the key order won: three Corals of
   weight 100 got 38 / 1 / 0 of 39 sessions (agent-b, 2026-10-23). A
   least-recently-elected tie-break was considered and rejected: it fixes equal
   weights only, and 100:100:10 would still send everything to the 100s.

## Decision

The live probed device set (key, availability, exclusion) is part of the share
topology signature, and a probe that returns another set recomputes the shares
at once. An enabled, available, eligible device with no benchmark result is
measured automatically by a `device`-phase run limited to it — one auto run at
a time, deferred while the node is busy (more than 2 cameras placed), retried
no sooner than 15 min and at most 3 times, never for a disabled or already
measured device. Share elections add a decaying count of recent elections
(half-life 30 min) to the running count, so the cumulative split follows the
weights even when sessions never overlap. The stored share source is not
touched; a fresh system reads `benchmark`.

## Consequences

- A node that carries cameras (usually the hub) is not measured automatically
  until it is quiet; the operator can still run it by hand.
- An auto run moves the node's cameras off for its duration, like a manual one;
  that is why the busy bound is small.
- Attempts were in memory: a hub restart gave a failing device a fresh budget
  of 3 (amended below).
- The election memory is in memory too; a restart costs a few unfair elections.
- A camera's on-motion sessions now alternate between equal nodes/devices
  instead of sticking to the first key; a device pin naming a key the elected
  node lacks is ignored as before.

- **Amended 2026-10-23 (first day live).** The automatic shares read only
  `pipeline` cells and never checked the model, so the `device`-phase run this
  decision starts could never move a node off the hardware table (the Mac
  stayed on `no-benchmark-results` after a completed run), and a failed
  pipeline cell for a heavier build sized agent-a at ~1%. Capacity is now
  the freshest cell for the model the device runs now (a pipeline cell, else a
  device cell's `kMax` as sessions), a cell for another model is ignored and
  logged once, and the planner's "has results" is the same predicate — so a
  device whose only result is for another model is measured again.
- Attempts and the retry spacing survive a hub restart (the orchestrator's
  settings store, per node × device), replacing "attempts are in memory"
  above; a device that gains a usable result is forgotten.

## Enforcement

`share-topology-signature.spec.ts` (the live set moves the signature with no
stored change), `auto-benchmark.spec.ts` (the planner and the scheduler),
`capacity-by-model.spec.ts` (the Mac and agent-a fixtures),
`auto-benchmark-predicate.spec.ts`, `auto-benchmark-persistence.spec.ts` (a respawn keeps
the budget and the spacing),
`share-election.spec.ts` and `share-election-history.spec.ts` (30 sequential
sessions split 10/10/10; 100:100:10 in proportion). Remove any of the three
mechanisms and the matching spec fails.
