---
id: D805
title: Cloud training is one hub orchestrator over a collection of thin cloud providers, and a result is never registered on its own
status: accepted (owns dataset versions, and routed by addonId, superseded by D824)
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/capabilities/training.cap.ts
  - packages/types/src/capabilities/training-provider.cap.ts
  - packages/types/src/training/trainer-contract.ts
  - packages/addon-training/src/orchestrator/job-engine.ts
  - packages/addon-training/src/orchestrator/plan-job.ts
  - packages/addon-training/src/orchestrator/return-flow.ts
  - packages/addon-training/src/providers/fake/fake-provider.ts
---

## Context

The operator wants to fine-tune the fleet's YOLOv9 root detector on their own
annotated frames without owning a GPU (cloud-training plan, operator decisions
2026-10-08: Modal first, root detector first, never auto-register). Every
cloud does the same few things — run a container with a GPU, move a dataset
in, show its output, hand files back — and differs only in how. Everything
around that (which frames, how they are split, what a job may cost, what a
result must prove before it touches a camera) must be the same for every cloud
and written once.

Rejected:

- **One addon per cloud, each with its own job logic.** Every rule (split,
  floors, cost cap, retention, return flow) would be written per cloud and
  diverge at the first edit.
- **Timers per job** ("check again in 30 s"). A hub restart would lose them; a
  job record plus the provider's jobKey tag is the whole truth and a reconcile
  loop re-derives everything from it.
- **Registering a result that passed its gate automatically.** A fine-tune is
  a model the operator has not seen run on their cameras; registering and
  pinning stay explicit clicks.

## Decision

**`training` is a hub-only singleton (addon-training's `training` entry) that
owns dataset versions, the job state machine, the cost guard, retention and
the return flow; `training-provider` is an internal, admin-only collection of
thin translation layers, routed by `addonId`, that knows nothing but its
cloud. Every cloud object is tagged with the orchestrator's jobKey, a retried
submit never starts a second GPU, a reconcile pass (boot, then every 30 s)
compares every live job with the provider, and a daily sweep stops cloud jobs
we hold no live record of. A result is registered, canaried or rolled back
only by an explicit operator call.**

- States: `uploading → submitted → starting → running → collecting → ready →
  registered → canary`; `failed{reason}`, `cancelling → cancelled`, `lost`,
  `expired`, `discarded`. A job found `uploading` with no task behind it was
  interrupted by a restart and fails as `hub-restart-during-upload`.
- The cost cap and the runtime cap are checked on every poll; the provider
  also enforces the runtime itself.
- Retention (operator decision): the cloud dataset is deleted as soon as the
  result is fetched and verified, a failed job's after the provider's grace
  (24 h by default); hub artefacts expire 14 days after `ready` or
  registration.
- Region, GPU, cost cap, runtime and grace are the PROVIDER addon's settings
  (they depend on the account), surfaced to the orchestrator through
  `describe().defaults`.
- One GPU job at a time; a second start is refused by name.
- Progress is the trainer's `CAMSTACK_EVENT` stdout lines, parsed by the
  orchestrator for every provider alike.

## Consequences

- A new cloud is a new `training-provider` entry and nothing else.
- The orchestrator never imports a provider: everything crosses `ctx.api`, and
  bytes cross `ctx.peerBytes` (D613) — the dataset as a pipeline-analytics
  offer, the bundle as a provider offer.
- GPU-time estimates are a first guess until real runs measure them; the cost
  cap is what bounds a wrong guess.

## Enforcement

`addon-training/src/__tests__/job-engine.spec.ts` (idempotent start, retried
submit, cost cap, restart, orphan sweep, checksum refusal, grace cleanup,
expiry), `provider-contract.spec.ts` (one suite over every provider adapter),
`return-flow.spec.ts`, and the cap-router specs `training.router.spec.ts` /
`training-provider.router.spec.ts` (admin gates).
