---
id: D396
title: A camera may detect on EVERY moving region, not only on the ones no box covers
status: accepted
date: 2026-09-08
supersedes:
applies-to:
  - packages/addon-pipeline/src/pipeline-runner/motion-crop-plan.ts
  - packages/addon-pipeline/src/pipeline-runner/small-subject-recovery.ts
---

## Context

The first-level detector sees the frame at its input size. On every
hardware-aware default that is 320 px, so a 4K frame is reduced 12× and a small
subject is a handful of pixels the model never emits.
[D377](adr-0377.md)/D378 shipped a second pass
for exactly this — `small-subject-recovery.ts` cuts a native-resolution square
around a moving region, runs the same detector on it and fuses the boxes back
before the tracker. It works, and this record does not replace it.

What it gates on is the question. The shipped rule runs on a region that is
**small** (`RECOVERY_MAX_REGION_FRAME_FRACTION` 0.25) **and mostly not covered**
by a full-frame box (`RECOVERY_MIN_UNCOVERED_FRACTION` 0.35). That is a rule
about a subject standing NEXT TO one the detector already sees, and D378 added
the counters precisely because "the pass stops running when a person is beside
the dog" was a live hypothesis the logs could not answer.

The measurement says the cheaper question is the better one. On camera 101,
against the production detector (`yolov9m-320-int8`, python+openvino) on the
node that runs that camera, over 38 visually confirmed positive frames from six
real animal pass-bys:

| arm | recall at our animal floor | pass-bys found |
| --- | --- | --- |
| full frame | 24% | 4/6 |
| motion-derived crops | 42% | 6/6 |
| the same crops, motion area bar lowered | 74% | 6/6 |

At the reference NVR's 0.70 the full-frame arm falls to 3/6 and the crop arm stays 6/6.
The score distribution moves with it: full frame median 0.780 / p25 0.526, crops
median 0.840 / p25 0.652.

Cost, measured on the node that would run it: **mean 0.25 extra detector
invocations per frame** at the shipped motion sensitivity, **0.88** at the
lowered bar. A crop costs about the same as a full frame (45.2 ms vs 40.8 ms
p50) — it is not cheaper, it is better aimed — and the whole thing is bounded by
the motion duty cycle and by the pass's own per-camera rate limit. The
top-3-by-area region cap **never bound** (0 of 156 frames).

False positives were collected rather than assumed: 3 085 quiet frames produced
27 motion-positive frames and 28 crop invocations. The full-frame arm produced
**0** boxes above any gate. The crop arm produced **3**, of which two are
genuine false positives and both are **night-IR corners** upscaled into a small
model — `vehicle 0.749` and `person 0.701`. **Zero false `animal` at any gate.**

## Decision

The second pass's region rule is **per camera**, selected by
`motionCropDispatch` on the `object-detection` step and defaulting to the
shipped `uncovered-region` rule — the same opt-in shape as the motion area
bar's own `minArea: 0` ([D394](adr-0394-the-motion-area-bar-judges-a-merged-subject-relative-to-the-view.md)),
so a deploy changes nothing until an operator moves a camera.

The measured rule (`motion-crop`, `motion-crop-plan.ts`) grows each motion box
×1.5 about its centre, grows every full-frame box that intersects a RAW motion
box ×1.25 and adds it as a **seed** rather than as an exclusion, merges
transitively what overlaps, clamps to the frame, takes the largest 3 and cuts
one square per region, deduped by **containment only**. It has no coverage gate
and no size gate.

A box that came out of a CROP and carries `person` or `vehicle` must additionally
clear **0.80** (`CROP_CLASS_FLOORS`). `animal` is deliberately not in that table.

Both rules remain **additive, never substitutive**: on frames where motion is
silent the crop arm scores 0% and the full-frame arm still scores 5%, and the
full frame is the only arm that can see a **stationary** subject at all.

## Consequences

- **The crop floor can cost a real distant person or vehicle** recovered at
  0.70–0.80. Nothing in the quiet-footage sample measures that, so the floor is
  a measured constant with the two numbers that set it written beside it, not a
  slider — and every box it removes is logged per camera (`floored` on the pass
  report, plus a line naming class, score and floor).
- **The magnification ceiling is kept, deliberately against the brief that asked
  for "grow to the aspect ratio and clamp".** At 1024 px the same 320 model
  scored the reference dog 0.52–0.76 and at 1280 px lost it entirely
  (`docs/benchmarks/pipeline-frame-model-eval.md`, `miss-dog-101`). A region
  longer than `RECOVERY_CROP_MAX_SIDE_PX` is TILED, never zoomed out. Dropping
  the ceiling would undo a measurement this repo already has.
- **"The detector's input aspect ratio" is a square here**, and that is a fact
  about the production detector (320×320 on every hardware default), not a
  simplification. A non-square detector would need this revisited, and the
  square placement now has one owner (`squareAround`) so there is one place to
  change.
- **The cost number is now measurable rather than predicted.** The pass report
  carries `framesOffered` — the frames the pass ran on plus every reason it did
  not — and `cropsPerFrame` computed from it. A number derived from an fps would
  silently disagree with the governor's real admission rate.
- **This is NOT a detail crop** ([D52](adr-0052.md)). `deriveDetailCropRect`
  derives the rectangle an enrichment step is fed from a KNOWN subject box, and
  `object-clip` is one vector index that tolerates exactly one such derivation.
  This module derives a square from a MOTION region, before any subject exists,
  for the FIRST-LEVEL detector; its output is a detection, never a vector.
  Extending the detail derivation with a motion-region mode was considered and
  rejected: it would put a detector's framing rule and a vector index's framing
  rule in one function, which is the exact coupling `check-clip-crop-single-owner.ts`
  exists to prevent.

## The number that says this did NOT work

Per camera, with `tags: { deviceId }`, on a camera moved to `motionCropDispatch`:

- **Recall.** If the animal recall on the ground-truth episodes does not rise
  above the full-frame arm's 24%, the recipe did not work.
- **Cost.** If `cropsPerFrame` on the pass report exceeds **1.0** at the shipped
  motion sensitivity, it costs more than it was measured to.
- **False positives.** If quiet-footage `animal` false positives are anything
  other than **0**, or if `floored` climbs while `recovered` stays flat, the
  floor is doing the wrong job.

## Enforcement

Unit tests pin the region rule, the containment dedupe, the cap, the
magnification floor, the frame clamp, the opt-in's default-off and its refusal
of a non-boolean value, and that the class floor leaves `animal` alone
(`packages/addon-pipeline/src/pipeline-runner/__tests__/motion-crop-dispatch.spec.ts`).
`scripts/check-clip-crop-single-owner.ts` already fails the build if this module
ever imports the detail derivation. The additive property is review-only: the
fusion step (`fuseRecoveredDetections`) can only append, and every caller keeps
the full-frame result object when the pass yields nothing.
