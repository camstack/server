---
id: D737
title: A YOLO26-seg root supplies the segmentation step from its own masks, and the seg builds are object-detection models
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/types/src/catalogs/root-model-supply.ts
  - packages/types/src/types/model-variant-groups.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/python/postprocessors/yolo_seg.py
  - packages/addon-pipeline/src/pipeline-runner/root-mask-supply.ts
  - packages/ui-library/src/composites/root-model-source.tsx
---

## Context

The camera root is YOLO26, and the `segmentation` step (a frame-plane refiner)
runs U2-Net-P once per detection crop, every frame. A YOLO26-seg model produces
the same COCO detections plus a mask for each one, so as the root it could
supply the step's masks without the second model. Measured on an M3 Pro
(ORT 1.30, heavily loaded, round-robin so the load hit every model equally):

| model | CoreML p50 | CPU min |
| --- | --- | --- |
| yolo26n / yolo26n-seg | 18.1 / 31.4 ms | 31.2 / 52.3 ms |
| yolo26s / yolo26s-seg | 25.7 / 44.5 ms | 96.5 / 146.5 ms |
| u2netp, one crop | 121 ms | 163.8 ms |

Today's path costs about 139 / 381 / 623 ms (n, CoreML) for 1 / 3 / 5
detections, plus U2-Net's own flood-fill postprocess, which takes 15–70 ms per
crop. yolo26n-seg alone costs 31 ms. With masks decoded over the box window
only, the seg postprocess is 0.9–1.8 ms per frame.

Three things did not hold as found:

- **The seg decoder did not decode boxes like the detector.** `yolo_seg.py` ran
  its own NMS on the end-to-end `[300, 38]` head, which `yolo.py` deliberately
  does not do. On a raw head it compared logits to the confidence floor without
  applying a sigmoid. It also decoded a mask for every candidate before NMS. A
  seg root would have kept and dropped different boxes than the detector does.
- **The step the operator named does not run.** `instance-segmentation` (the
  YOLO26-seg step) is in `DORMANT_PIPELINE_STEPS`, and no camera tree carries
  it. The masks every consumer reads come from `segmentation` (U2-Net-P): the
  mask, its width and height, and `refinedBbox`, which is the bbox of the
  mask's largest component.
- **Two catalog rows would describe one artifact.** One option was a second
  root-only row for each seg build (`yolo26n-seg-root`), with the same
  weights as the `instance-segmentation` row. That breaks D703's "one entry per
  model".

## Decision

**A root whose decode emits a mask with every detection declares a `mask`
supply for `segmentation`. Under the D730 decision (`resolveRootSupply`, the
step's own `useRootModel` flag, default ON for masks) the step is then not
dispatched, and each root detection carries its own mask in the step's shape.**

1. **One entry per model.** `yolo26{n,s,m}-seg` move into
   `OBJECT_DETECTION_MODELS`, keeping their ids. Each carries
   `postprocessor: 'yolo-seg'` and is grouped as family `yolo26-seg`.
   `INSTANCE_SEGMENTATION_MODELS` is a filter of that catalog, so the dormant
   step references the same objects. No default names a seg build: not
   `defaultModelId`, not the format defaults, not the hardware defaults.
2. **The supply is a fact of the decode.** `deriveMaskSupplies` reads the
   entry's postprocessor (`MASK_EMITTING_POSTPROCESSORS`). `rootSuppliesOf`
   adds the mask supply on read, including for a stored declaration. A seg
   root therefore declares animals 6/8, vehicles 5/8 and masks.
3. **Boxes are the detector's own decode.** `yolo_seg.py` calls
   `yolo.decode_yolo11_nms_rows` or `yolo.decode_raw_yolo_columns`, keeping
   the row or column index. Both give the same floor, sigmoid detection, NMS
   (none on an end-to-end head), letterbox inversion and rounding. Masks are
   computed only for kept detections, over the box mapped back onto the
   prototype grid. `postprocess_yolo` output is unchanged.
4. **Runtime: `root-mask-supply.ts`.** If the supply is effective and the step
   would run, `applyMaskFill` drops `segmentation` from the dispatched tree.
   `applyRootMasks` then derives `refinedBbox` from each root mask's largest
   4-connected component, the same reduction as `saliency.py`. If the step
   ran its own model, its masks pass untouched. If neither happened, the seg
   root's masks are stripped, so masks the operator did not switch on reach
   nobody. The step is frame-plane and never announced: `suppliedSteps` skips
   the mask kind.
5. **UI.** The step editor shows "Use the root model (<name>)" on
   Segmentation under a seg root, and shows it inactive under a plain one.
   Model Studio badges read "masks". The grouped picker shows the YOLO26-seg
   family with the hint "detection + masks, slightly heavier".

## Consequences

- **A seg root is not the same network as yolo26n.** Its boxes are decoded
  identically, but its weights differ. On the reference images the persons and
  cars match, and the non-macro classes differ (`chair` against `tie`).
  Switching the root changes detections the way any root change does.
- **Root masks are coarser.** They follow the model's mask grid (160 at a 640
  input, so 4 input px per cell), cropped to the box and mapped linearly onto
  it. U2-Net returns 320×320 per crop. A root mask is also much smaller on the
  wire: typically 20×60 bytes against 102 400 for U2-Net.
- The seg root decodes masks for every camera that runs it, whether or not the
  camera uses them. That cost is 0.9–1.8 ms per frame, and the runner strips
  the unused masks.
- The `segmentation` step keeps its own model and stays opt-in. Switching back
  to a plain root re-runs U2-Net with no write.
- **Deploy order.**
  1. `@camstack/types`, through a published `@camstack/server`. It carries the
     schema union, `rootSuppliesOf` and the picker hint.
  2. `addon-pipeline`. It carries the catalog move, the Python decoder and the
     runner.
  3. `addon-model-studio` and the admin UI. They come with ui-library.
- Until `addon-pipeline` is deployed, nobody can select a seg root.

## Enforcement

- `test_yolo_seg_root.py` checks box parity with `postprocess_yolo` on both
  head layouts and under the NMS knob. It also checks that each kept detection
  carries its own mask, and it fails on the old decoder.
- `root-model-supply-mask.spec.ts` covers the declaration, the plain → seg →
  plain switch, the default and the wire shape.
- `executor-seg-root.spec.ts` runs the real object-detection definition and
  checks identical detections and discard trail, plus the masks.
- `root-mask-supply.spec.ts` covers fill, strip and pass-through.
- `root-mask-supply-through-run-inference.spec.ts` checks that the step is not
  dispatched, that `refinedBbox` is set, and the one log line.
- `model-variant-groups.spec.ts`, `grouped-model-selector.test.tsx`,
  `agent-step-editor-root-model.test.tsx` and `fill-badges.test.tsx` cover the
  UI.
