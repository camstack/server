---
id: D215
title: The CPU is a fallback, never a peer of an accelerator
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
  - packages/addon-pipeline-orchestrator/src/device-balancer.ts
---

## Context

On 2026-08-21 the hub container hit **1543% CPU**, with a single ONNX inference
pool at 647% across 199 threads. Nobody had turned anything on: `cpu` sat
stored `enabled: true, weight: 1` beside two OpenVINO devices at weight 50 —
a shape that reads as "1% of the work".

It was taking **44%**. The balancer minimises `capacityScore / weight`
(`load-balancer.ts`), so a momentarily-idle weight-1 device scores `0 / 1 = 0`
and beats a loaded accelerator at `1 / 50 = 0.02`. Weight distributes SUSTAINED
load; detection sessions are ephemeral (open on motion, close), so at nearly
every election the CPU was empty and won. Measured: 188 of 428 dispatches in
ten minutes, `reason=capacity` on every one — not a tie-break, an outright win.
Two aggravations that day: one camera in dispatch churn (150 dispatches in ten
minutes) multiplied the elections, and a pool restart left the CPU pool holding
nine models including the heaviest (rfdetr package detection, three
classifiers).

Turning the weight down further cannot fix this: any finite weight loses to an
empty device, because the comparison is a ratio.

## Decision

Last-resort is a property of ELIGIBILITY, not of weight. While a node has any
enabled ∧ available accelerator that can host the camera root, the CPU
(`backend === 'cpu'`) is excluded from the candidate set with the reason
`accelerator-preferred`. It returns to the set the moment no such accelerator
does — a node whose accelerators are disabled, unplugged or root-incapable must
keep detecting, which is the entire purpose of keeping the CPU configured.

An operator-disabled CPU stays disabled (reason `disabled`) either way; a
CPU-only node is unaffected.

## Consequences

`enabled: true` on a CPU no longer means "balance work onto it" — it means "be
the safety net". That is a deliberate narrowing of what the toggle promises,
and the exclusion is reported, not silent. A node that genuinely wants CPU
inference alongside an accelerator can no longer express it through this
surface; nothing asks for that today, and the failure it prevents cost a live
hub 1543% CPU. The stale `enabled: true` rows that produced the incident are
now inert rather than dangerous.
