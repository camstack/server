---
id: D463
title: A timing line names the engine it ran on, or omits the field — never null for both
status: accepted
date: 2026-09-11
applies-to:
  - packages/addon-pipeline/src/pipeline-runner/runtime-labels.ts
  - packages/addon-pipeline/src/pipeline-runner/timing-sampler.ts
---

## Context

Every `pipeline stats` line on this hub ended `pipelineRuntime=null
pipelineModels=null` — 208 of 208 in a ten-minute window, on every camera and
every node, and the same on the agents.

It was not a transient and not a read that failed. `TimingSampler.runtimeInfo`
is initialised to `{}`, and a repo-wide search for `runtimeInfo =` finds
NOTHING outside its own declaration. The field has been printing `null` since
it was added. Its docblock called the labels "purely cosmetic" — a leftover
describing a design nobody wired, which reads as verification and is why this
survived (the same shape as D438's instrument, born blind).

The cost is that the question these lines exist to answer cannot be answered:
300 ms of inference means one thing on a CPU fallback and another on the NPU,
and "why is 102 worse than 101?" has no engine column to look at.

## The second defect, found by the operator within the hour

Fixed naively, the labels read `getSelectedEngine` — the node's CONFIGURED
device — and printed `python/openvino/npu`. The operator asked what that means
"se girano due devices", and it was the right question. `listLoadedEngines` on
this hub:

```
openvino npu  kind=runtime      pid=391010  10 models
openvino gpu  kind=device-pool  pid=391077  the same 10 models
```

TWO complete pools on two accelerators. The label named one and hid the other.
A configured value printed on a telemetry line reads as a measurement and is
not one — the same defect as the `null`, one level further in.

And `python` is not information: every engine available on this cluster is
python (onnx, openvino, edgetpu); the `node` runtime exists only in the type. A
token that cannot vary costs a column on every line and tells nobody anything.

## Decision

The labels are built from what is RESIDENT — `pipelineExecutor.listLoadedEngines`,
which already existed and whose own docblock says a `device-pool` "runs
alongside the `runtime` engine on a DIFFERENT accelerator". Every resident pool
is named (`openvino/npu+gpu`, runtime pool first); a model only SOME pool holds
carries that pool's device (`model@gpu`); the runtime token is omitted. An absent field means "not
known"; `null` is never printed to mean both "no engine" and "nobody asked".

Two backends resident at once become `mixed/...` rather than a chosen winner:
picking one would repeat exactly the defect this record exists to fix.

## Consequences

- Refreshed on a slow timer (5 min), not read once at boot: the engine is
  provisioned lazily and an operator can re-select it, so a boot-time read
  would pin whatever was true before provisioning finished. A stale label is
  worse than the null it replaces.
- Both reads are best-effort and log at `debug` once per refresh. The signal is
  the field's ABSENCE in the line, which the hub writes at `info`; a warn per
  refresh on a node with no engine would be a storm.
- `buildRuntimeLabels` is pure, so what a FAILED read prints is pinned by a
  test rather than discovered in production.

## Enforcement

`runtime-labels.spec.ts` pins all of it, including the two cases that made the
original field useless: an engine that cannot be read must not erase the
models, and unknown steps are ABSENT rather than `[]` (which would claim the
pipeline runs no models). Nothing yet checks that a *new* label field is
actually assigned by someone — that is the class of defect this was.


## Known limitation, measured 2026-09-12

`pipeline-executor` is a SINGLETON capability: an agent registers its own
provider `isActive:false`, and the cluster-active one is the hub's. So "ask
THIS node what it has resident" is not a question the cap's routing answers
today, and all three available forms were tried against the live cluster:

| form | hub | `agent-a` (N100, no NPU) |
| --- | --- | --- |
| unpinned | correct on every line | the HUB's `openvino/npu+gpu` on 3 of 32 |
| `nodePin(nodeId)` | **null on 34 of 35** | null on all — the inactive local provider answers an EMPTY LIST rather than throwing, so there is no failure to log |
| `{ nodeId }` routing field | 7 correct of 32 | null on all |

Unpinned is shipped as the least wrong. **The consequence to know: on an agent
the label may name the HUB's pools.** A reader who does not know this would
conclude an N100 has an NPU, which is why it is written here and not left to be
rediscovered.

The real fix is for the cap to answer a per-node question — which is a cap
change, not a caller change, and is not worth one for a telemetry label.
