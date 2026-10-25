---
id: D791
title: The node benchmark is one node at a time, in an orchestrator-owned benchmark mode that is always restored, and what it measures on the node beats the latency table
status: accepted
date: 2026-10-08
supersedes: D646 (where a capacity measurement runs and who owns it); D745 (only "never from a benchmark"); D755 (only the default share source)
applies-to:
  - packages/types/src/pipeline/node-benchmark/**
  - packages/types/src/pipeline/auto-tune/recommend.ts
  - packages/types/src/pipeline/load-balancing/schemas.ts
  - packages/addon-pipeline-orchestrator/src/node-benchmark/**
  - packages/addon-pipeline-orchestrator/src/node-topology.ts
  - packages/addon-pipeline-orchestrator/src/placement-service.ts
  - packages/addon-pipeline/src/pipeline-runner/node-bench/**
---

## Context

The benchmark addon could not answer the question it exists for — what
this node can carry. Its capacity ramp was a custom action, and custom
actions reach only the hub's runner: the Preflight told the operator that
the node they had chosen (the Mac) would not be measured, and the hub's own
ramp refused because the hub is never quiet. Making a node quiet was a
script that switched every camera's detection off (the cameras went blind)
with nothing to undo it after a crash. The measured numbers, when there
were any, fed nothing: Auto tune read a static table by hardware class
(D745, "never from a benchmark") and the `benchmark` share source (D755)
read a store that did not exist.

Considered and rejected:

- **Switching the node's detect flag off for the run.** The flag is the
  operator's (D62); a crash leaves it off with no record of the old value,
  and cameras PINNED to the node go pending — blind.
- **Rewriting the pins of the cameras on the node.** A second writer of
  operator intent, and the restore becomes a migration that can fail half
  way.
- **Driving the measurement from the hub.** Frames would cross the network
  per call (D9): an N100 measured 221 ms per call, all of it transport.
- **A dry-run session through the real runner path.** Needs a no-write
  attach that does not exist; a leak would put benchmark tracks in the
  operator's timeline. Deferred.

## Decision

**The pipeline orchestrator owns the node benchmark.** One run
cluster-wide. It persists a restore manifest FIRST, then puts the cluster in
**benchmark mode** for the chosen node: the node is not a detection
candidate for any camera another node can serve, and a node pin naming it is
ignored at read time (the stored pin is never rewritten, so ending the mode
restores it); device pins bind no node and follow the elected node. Cameras
on the node are moved by a scoped rebalance (pinned ones included); a camera
whose only frame source is the node stays and the run is flagged
contaminated — never blind. A hub run is always contaminated (its own duties
continue). The orchestrator drives the TARGET node's runner through
`nodePin` (cap methods, not custom actions), polls it, and restores in a
`finally`: mode off, the moved cameras re-placed, the runner stopped, the
finished cells stored, the run recorded, the manifest removed last. A
manifest with no live run — at boot or on the 30 s reconcile — is restored
at once (reconciled against the registry, never trusted to a timer or an event); the runner also stops
itself at the deadline. Nothing the operator owns is written.

**The node measures itself** on frames decoded once into RAM — the public
bench clip when its pinned sha256 matches, else the node's reference images
(the result says which): per device × candidate detector, an open-loop ramp
of streams at the camera rate whose p95 must stay inside the frame
interval (`device`); then the chosen detector with the operator's detail
steps on the full plane, ramped in parallel sessions under the same gate
plus node CPU ≤ 85 % and free RAM ≥ 15 % (`pipeline`). Nothing is emitted:
the executor is called directly. A pipeline cell whose requested steps
never ran is not stored.

**Measured on this node beats the table.** A result is fresh when it is the
newest for its cell, younger than 30 days, and was measured on the pool the
device runs today (same runtime and tuning; an unanswered pool is unknown,
never "changed"). Auto tune lays a node's fresh `device` cells over the
hardware-class table and every choice names its source; a node of unknown
hardware is recommended from its measurements alone. The automatic shares
default to the `benchmark` source: each node is sized by its fresh
`pipeline` cells, falling back to the table per node and saying so; a stored
`hardware` stays the operator's choice, and a stored D750 `auto` still reads
`hardware`. Session caps stay advisory (D748). Writing or deleting a result
recomputes the shares (logged).

## Consequences

- The `benchmark` share source is the default: until a node is
  benchmarked, the Load balancing tab says "sized from hardware" for it.
- A run moves sessions; the drain is refused (and restored) when the node
  does not empty within two minutes.
- The `pipeline` measurement is the inference plane (root + detail steps)
  on varied frames. It does not include the session decode, motion or the
  hub tracker; a dry-run session path is the follow-up that would.
- Model revision and driver are not in the fingerprint yet; a re-downloaded
  model of the same id does not make a result stale.
- The bench clip ships separately (HF dataset repo) and its hash is pinned
  in the runner; until it is published every run says
  `reference-images`.
- The operator pause script (`scripts/capacity/pause-restore.mjs`) is
  obsolete: benchmark mode is the pause, and it never blinds a camera.

## Enforcement

- `packages/types/src/pipeline/node-benchmark/__tests__/benchmark-mode.spec.ts`
  — eligibility, pin view, moving vs staying cameras, refusals, duration.
- `.../__tests__/results.spec.ts` — standing: age, runtime, pool tuning,
  superseded; the two reductions Auto tune and the shares read.
- `packages/addon-pipeline-orchestrator/src/__tests__/node-benchmark-service.spec.ts`
  — manifest before mode, every way out restores, boot restore, one run.
- `.../__tests__/node-benchmark-mode-e2e.spec.ts` — a pinned camera leaves
  the node and comes back (red with the pin view or the pinned-rebalance
  exception removed).
- `packages/addon-pipeline/src/pipeline-runner/node-bench/__tests__/*` — the
  ramp gates, frame rotation, abort, deadline, model cleanup, clip hash.
- `packages/types/src/pipeline/auto-tune/__tests__/recommend-measured.spec.ts`
  and the D791 block of `auto-tune-service.spec.ts` — measured beats the
  table, unknown hardware, unreadable results.
