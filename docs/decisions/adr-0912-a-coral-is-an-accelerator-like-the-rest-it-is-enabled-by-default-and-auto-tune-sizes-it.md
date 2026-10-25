---
id: D912
title: A Coral is an accelerator like the rest — enabled by default, and Auto tune sizes it
status: accepted
date: 2026-10-23
supersedes: D39
applies-to:
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
  - packages/types/src/pipeline/auto-tune/recommend.ts
  - packages/types/src/pipeline/auto-tune/detector-performance.ts
---

## Context

D39 made the Coral opt-in: a Coral with no stored entry was `enabled:false`, and
Auto tune reported it (`coral-untouched`) and never gave it a model. Two facts
held that up. On 2026-08-01 a hub Coral nobody enabled took an equal share of
the session rotation, ran a weaker tflite SSD and left camera 101 at 2.4 fps;
and the YOLOv9-only perf table (D745) had no Edge TPU build to size it from.

Both are gone. Since D908 the Coral default is `yolov9s-320-edgetpu` — YOLOv9,
measured 23–32 ms warm across usb/pci/pci:1 on agent-b
(`docs/benchmarks/2026-10-22-coral-pcie-amd-phoenix.md`, second section). And the
failure the opt-in answered was a share problem, not an enrolment problem:
automatic shares (D755) weigh a device by its Auto tune throughput, which the
Coral never had. Left as it was, an operator who ENABLED three Corals on
agent-b gave them 0 of 1766 sessions, because `chosen` was null and so
was the weight.

## Decision

A Coral is an accelerator like the NPU or iGPU. With no stored entry it is
`enabled:true`; an explicit stored `enabled:false` wins. CPU-class devices stay
opt-in (fallback only). Auto tune sizes an enabled, available Coral at its
default model `yolov9s-320-edgetpu` from a `coral` column of the latency table
(32 ms / 31 fps, the slowest of the three measured units, so a PCIe unit is
sized conservatively); the Coral is its own pick and does not join the
accelerator group's shared model. The `coral-untouched` reason and the
`coral-enabled` warning are deleted.

## Consequences

- The `coral` columns are one cell each, the 320 size only (D745's table stays
  YOLOv9). `amd-phoenix/coral` is measured; other hardware classes carry the
  same cell as `measured:false` until a Coral is benchmarked there.
- A freshly plugged Coral enters the rotation at a speed-proportional weight
  (about 31 fps against hundreds for an NPU), not at an equal share.
- Auto tune Apply writes the Coral's model pin (equal to its default); a node whose only sized device is a Coral counts as touched.
- An election among several devices now names one when a Coral sits beside an NPU; rebalance-migration-attach pins that case with the Coral disabled.
- Detection quality on a Coral stays below the larger accelerator models; an
  operator who does not want it switches it off.

## Enforcement

`recommend.spec.ts` (an enabled Coral is chosen at `yolov9s-320-edgetpu`, a
disabled one is not), `capacity-shares.spec.ts` (an enabled Coral earns a
nonzero weight), `node-inference-devices-cap.spec.ts` (no stored entry means
enabled), and `detector-performance.spec.ts` (the table equals
`detector-latency.json`).
