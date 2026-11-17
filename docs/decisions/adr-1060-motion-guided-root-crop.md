---
id: D1060
title: The object-detection root runs on a motion-guided crop, chosen per frame, at the same inference count
status: accepted
date: 2026-11-17
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/motion-root-roi.ts
  - packages/addon-pipeline/src/detection-pipeline/pipeline/executor.ts
  - packages/addon-pipeline/src/detection-pipeline/provider.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
---

## Context

The root detector saw the whole frame letterboxed to its input. A subject that
is small relative to the frame arrives at the model as a few dozen pixels. On
camera 1441 (4256x1888) a person at the conservatory door is about 100x290
native px, about 15x44 px at the model input, and scores mostly under the
0.55 person floor: on 2026-11-17, of six real passages seen by the neighbouring
camera, none became an event on 1441. The detail plane cannot help: it only
enriches subjects the root already found.

The decode worker already crops and scales a rectangle into the model input
for every frame (`frame-view-geometry.ts`), and a `crop-zone` root (package
detection) already runs on a crop with its boxes re-projected to the frame.

The first proposal used a crop no smaller than the model input in native
pixels (640). The offline replay (int8 YOLOv8m, CPU OpenVINO, one inference per
frame in every mode) showed it HURTS: one passage dropped from 9 hits to 2 and
lost its birth. This model scores large subjects badly — a person about 300 px
tall in the 640 input scored 0.09; the same person at about 75 px scored 0.65.
With a minimum side of 1280 or 1888 px the crop recovered two passages that had
no birth and gave a third 6x more hits at or above 0.55; on the courtyard camera
no passage lost its birth, idle tracks improved (27 to 78 and 7 to 42 hits), and
none of 370 full-frame hits fell outside the crop. Person false positives on the
rain negative control stayed at 0; vehicle 38 against 44.

## Decision

The object-detection root (`MOTION_ROI_ROOT_STEP_ID`) runs, per frame, on
either the full frame or ONE crop derived in ONE module,
`detection-pipeline/motion-root-roi.ts`: the union of the motion analyzer's
merged subjects (D394) and the root's own boxes from its recent frames, plus a
15% margin, expanded to the model aspect, grown to at least the larger of 0.45x
the frame's long side and 2x the model input (never a native 1:1 crop), and
shifted inside the frame. The full frame runs when there is neither motion nor
a recent box, when the crop's long side would exceed 0.6x the frame's, and on a
forced full frame at least once a second per camera. The crop REPLACES the full
frame; it never adds an inference. It is automatic for every camera with no
setting. A `crop-zone` root always keeps its package-zone crop: the motion crop
never applies to it, whatever the decision names. Each frame's choice and reason
ride the per-camera `pipeline.trace` event as `rootSource`.

Rejected:

- **Fixed tiles** over the frame: 2-3x the inference on every camera, all the
  time.
- **A larger model or a larger input**: every camera pays for the few whose
  subjects are small.
- **A 640 px minimum side** (a native 1:1 crop): measured worse, above.
- **Alternating far-apart motion clusters frame by frame**: never better in the
  replay; a union too large falls back to the full frame instead.

## Consequences

- The floor is model-dependent. A new object-detection root model needs a scale
  sweep before the constants still hold.
- The root's own recent boxes stand in for the live tracks' predicted boxes:
  the tracker runs in the analytics process, and reading its tracks at frame
  rate would cross a process boundary per frame. A still subject stays in the
  crop for `ROI_LIVE_BOX_MAX_AGE_MS` after its last box and is otherwise seen on
  the forced full frame.
- A crop that covers a static object the full frame never scored can birth a
  static false positive: in the replay a wall planter on 1441 read as a
  "vehicle" whenever a 1280 crop covered it. The parked-object registry (D683)
  must absorb such a subject; if it does not, that is a registry defect, not a
  reason to shrink the crop.
- A camera too small for the 2x floor to fit under the 0.6 ceiling (a 1080p
  main stream with a 640 model) never crops and behaves exactly as before.
- Score floors (`model_floors`) were calibrated on full frames and may need a
  crop-aware check.
- The motion subjects reach the executor on `runPipeline.motionRegions`, only
  on the co-located `frameRef` path (D9: the frame stays in the detection
  group). D52 is untouched: this is not a detail crop and shares no code with
  `deriveDetailCropRect`.

## Enforcement

`motion-root-roi.spec.ts` pins the geometry (minimum side, maximum fallback,
edge clamping, aspect) and the forced-full cadence;
`executor-motion-root-roi.spec.ts` pins the re-projection to frame
coordinates and the `crop-zone` precedence. Live: the `rootSource` field on a
camera's `pipeline.trace` events.
