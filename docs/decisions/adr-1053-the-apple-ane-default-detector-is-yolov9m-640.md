---
id: D1053
title: The Apple ANE default detector is yolov9m-640
status: accepted
date: 2026-11-15
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/default-detection-model.ts
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
---

## Context

The hardware-aware default (`MODEL_BY_CLASS`) gave every accelerator class a
320-input detector, and the docblock forbade promoting any of them to 640: the
controlled evaluation in `docs/benchmarks/pipeline-frame-model-eval.md` had
recovered 0/3 misses at the 0.50 threshold and failed the false-positive and
capacity gates. 640 stayed an explicit operator pick (Best settings, D745).

On 2026-11-15 the garage camera (4K main stream, on-motion sessions on the Mac
mini's ANE) tagged every clip "motion" while a person was plainly in frame:
`yolov9m-320` scored the downscaled, distant person below the 0.35 floor
(`belowFloor.person <0.35` on 71 of 132 stats lines that day). The capacity
argument does not hold on this class: the ANE runs `yolov9m-640` at
p50 10.2 ms / 98 fps (measured, `detector-performance.ts`), and the person
recall table gives 0.85 at 640 against 0.65 at 320.

## Decision

The `apple-ane` class defaults to `yolov9m-640`, in both places the default is
computed (`resolveDefaultDetectionModel` and the orchestrator's
`defaultModelIdForDevice`). Every other class keeps its 320 default and the
rule that 640 there is an operator pick.

## Consequences

A CoreML node with no model pin runs the 640 build: about three times the
ANE time per frame, still far under the session budget. A node that wants 320
pins it per device. The false-positive gate of the original evaluation was not
re-run for the ANE; the person floors per model (`model-catalogs.ts`) apply
unchanged.

## Enforcement

`default-detection-model.spec.ts`, `hardware-aware-auto.spec.ts`,
`node-inference-devices-cap.spec.ts` and `root-supply.spec.ts` assert the ANE
default.
