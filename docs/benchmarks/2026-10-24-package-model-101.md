# The package model does not see the carton on 101 (2026-10-24)

covers:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/python/postprocessors/rfdetr.py
  - packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/python/postprocessors/rfdetr.py
last-verified: 2026-10-24

Camera 101 ("Camera front door", 3840×2160) left an Amazon carton on the
step beside the pumpkins after courier track `we6pvrd072` ended at
1792841720881. `rfdetr-package` reported nothing. This page is the replay.
Production settings were not written. Every live call is
`pipelineRunner.runStatelessStep` (D54), node-pinned. The scores under 0.5
come from the same ONNX weights, offline, with the catalog preprocess and
with the confidence gate removed.

## Frames

| id | what it is | pixels | when |
| --- | --- | --- | --- |
| 1916795 | native keyFrame, event-media `m/1916795` | 3840×2160 | 1792841784117, 63 s after the courier track. OSD 24-10-2026 Sat 13:36:12. No person. The carton is on the mat. |
| 1916796 | 960×540 twin of that instant | 960×540 | same |
| 1917029 | native keyFrame, event-media `m/1917029` | 3840×2160 | 1792841900734, 3.0 min after the courier track. OSD 13:38:09. A person is on the mat. The carton is still there. |
| 1917032 | 960×540 twin of that instant | 960×540 | same |

The package zone is "Uscio" (`cfeec78c-8d69-4678-9d25-937193eacb5d`). Its
normalized union, the rectangle `resolvePackageCropBbox` crops, is
x 0.127–0.752, y 0.359–1. On the native frame that is left 488, top 775,
2399×1385. On the 960 frame it is left 122, top 194, 600×346.

A native keyFrame is about 3 MB. `runStatelessStep` answers HTTP 413 at that
size (the body limit is ~1 MB). Live calls used JPEGs under 200 KB. The
offline ONNX run cropped the original native JPEG, not the recompressed copy
that was prepared for the API.

## What the live path feeds the model

`rfdetr-package` is the only package model in the catalog. Input 576×576,
`preprocessMode: 'resize'` (square stretch, bilinear), `inputNormalization:
'imagenet'` (RGB, /255, mean 0.485/0.456/0.406, std 0.229/0.224/0.225),
postprocessor `rfdetr`. The catalog comment says that pair matches the
export. The postprocessor reads `dets` as cxcywh normalized to the square
input (no letterbox unpad) and takes class column 1 after sigmoid; column 0
is the empty slot. NMS IoU 0.50, drop a box whose area fraction exceeds 0.60.

The pool floor for `package-detection` is 0.05
(`PER_MACRO_POOL_CONFIDENCE_FLOOR`), so the postprocessor emits anything at
or above that. The step's `defaultConfidence` is 0.5, and that is the
`minConfidencePackage` the executor applies. `runStatelessStep` has no
threshold field and synthesizes the step with no settings, so the 0.5
default stands. An offline score of 0.41 is a live result of zero boxes.
That is the filter, not a runtime that returned nothing.

Camera 101's package step runs on `mac-mini` (`coreml:all`).
The same stretched zone was also sent to the hub (`openvino`). Both returned
`kind: ran` and zero boxes. The two runtimes agree.

## Runs

"On the carton" means a query whose center falls in the zone window
x 0.68–0.92, y 0.58–0.85, which is the Amazon carton under the pumpkins.
The boxes at 0.3–0.4 with centers near (0.75, 0.48) were drawn on the zone
crop: they sit on the pumpkins. The carton has no box around it.

### `rfdetr-package`, live API (floor 0.5, so n = 0 on every row)

| node | input | result |
| --- | --- | --- |
| Mac, CoreML | A and B, native zone stretched to 576² | ran, 0 boxes |
| hub, OpenVINO | same two | ran, 0 boxes |
| Mac | A and B, 960 zone stretched to 576² | ran, 0 boxes |
| Mac | A and B, native full frame stretched to 576² | ran, 0 boxes |
| Mac | A and B, 960 frame as-is (the stateless crop center-squares a non-square bbox) | ran, 0 boxes |
| Mac | A and B, 960 zone 600×346 as-is (center-square clips the wide zone) | ran, 0 boxes |

### `rfdetr-package`, offline ONNX, same weights, confidence 0

Preprocess is named in the row. Stretch is PIL bilinear to 576². Letterbox
pads with gray 114 and the coordinates below are in that 576 canvas; unpadding
the top letterbox box (scale 576/2399, pad-y ≈ 122) puts its center at about
(0.77, 0.48) of the zone, the pumpkin cluster.

| frame | input | preprocess | best package score | queries ≥ 0.05 | queries ≥ 0.5 | where the best box is |
| --- | --- | --- | --- | --- | --- | --- |
| A 1916795 | Uscio zone | stretch + ImageNet (the live contract) | **0.415** | 11 | 0 | pumpkins, 0.036×0.059 of the zone |
| A | Uscio zone | stretch, /255 only | 0.175 | 7 | 0 | same cluster |
| A | Uscio zone | letterbox + ImageNet | 0.642 | 4 | 1 | pumpkins, after unpad |
| A | full frame | stretch + ImageNet | 0.178 | 6 | 0 | not the carton |
| A | full frame | letterbox + ImageNet | 0.136 | 2 | 0 | not the carton |
| B 1917029 | Uscio zone | stretch + ImageNet | **0.476** | 14 | 0 | the person, 0.294×0.389 of the zone |
| B | Uscio zone | stretch, /255 only | 0.217 | 12 | 0 | pumpkin cluster |
| B | Uscio zone | letterbox + ImageNet | 0.609 | 17 | 2 | pumpkins, after unpad |
| B | full frame | stretch + ImageNet | 0.380 | 10 | 0 | the person |
| B | full frame | letterbox + ImageNet | 0.461 | 17 | 0 | the person |

Best query whose center is on the carton, live-contract preprocess, full zone:
**0.033** on frame A, and on frame B the window's highest query is the person
box (0.476), not a carton-sized box. Column 0 (background) never exceeds
~0.002, so the class index is not swapped.

Two crops that production does not send, same preprocess, frame A:

| crop | best score | what the boxes cover |
| --- | --- | --- |
| pumpkins only (zone fraction x 0.70, y 0.40, 0.16×0.20) | **0.917** | the pumpkins |
| the carton, pumpkin sliver cut off | **0.423** | fragments of the carton and the Amazon tape, not one box around it. Still under 0.5 |

So the model is not mute. It is sure the pumpkins are a package when they
fill the tensor, and it only reaches 0.42 on this carton when the carton
fills the tensor. At the scale the zone crop actually is, the carton scores
0.03.

### Root detector, COCO parcel proxies

`yolov9m-640` on the Mac, letterbox 640, pool floor 0.05. `suitcase`,
`backpack` and `handbag` map to macro `package`. None of those classes came
back. What did:

| input | boxes |
| --- | --- |
| A native and A 960 | vehicle / Car 0.737 and 0.711. No package. |
| B native and B 960 | person 0.917 / 0.923 (the man on the mat), person 0.608 / 0.601 (the pedestrian on the street). No package. |

### Other package models

The catalog has no second package model (`yolov8n-package` was removed) and
no open-vocabulary detector. `siglip2-b16-224` is an embedding, not a
detector. Nothing in the catalog takes a prompt "cardboard box / parcel".

Model Studio on the hub has seven plus catalog SSD models, tflite only, 320²,
labels include `package` and `amazon`:

- `frigate-plus-e39924321228f76edd6b727c0cf2a4be`
- `frigate-plus-c7b38453956cda87076baba4aca213e6`
- `frigate-plus-e08864ec08832bd52c6037984ce72f1c`
- `frigate-plus-e074d6405b3257c98d255cd2efc9d21f`
- `frigate-plus-c241fae21de50ecf6c0f2a63769dcacd`
- `frigate-plus-be9c11b486ba0e2b8ea13338d4cc66ee`
- `frigate-plus-35877a6045227082ca72e73d6d34c72a`

Online engines: hub, agent-a and agent-b are `onnx`+`openvino`;
the Mac is `onnx`+`coreml`. None is tflite. The first id, on the A zone
stretched to 576²:

| node | result |
| --- | --- |
| hub | refused, `execution-failed`: no openvino build (available: tflite) |
| Mac | refused, `execution-failed`: no coreml build (available: tflite) |

No score. `amazon` would not have become a package sighting anyway:
`PLUS_CATALOG_UNMAPPED_LABELS` marks it `attribute`, and with
`preserveOriginal: false` the executor drops it as `class-filter`. Only the
`package` label maps to the package macro.

### LLM, confirmation only

Local profile `mac-lmstudio-qwen3vl` (`qwen3-vl-4b-instruct-mlx`,
base URL on the LAN), `llm.generateVision`, the 600×346 zone crop.
Asked for JSON: is there a cardboard parcel, and a box in fractions of the
image.

| frame | answer | latency |
| --- | --- | --- |
| A | `cardboard_parcel: true`, `pumpkins: true`, `person: false` | 10.3 s |
| B | `cardboard_parcel: true`, `pumpkins: true`, `person: true` | 5.1 s |

The booleans match the picture, including the person present only on B.
The boxes do not: both are given as pixels past the right edge of a
600-wide image (`x` 672 and 648). Presence confirmation only, not a box
to train on.

## Verdict

Not a preprocess bug. The live contract is square stretch to 576 plus
ImageNet, which is what the catalog says the export was trained with.
Dropping ImageNet lowers the best score (0.415 → 0.175, 0.476 → 0.217).
Letterbox scores higher (0.642 / 0.609) and those boxes unpad onto the
pumpkins, so adopting it would promote the pumpkins, not the carton.

Not a threshold. On the zone the carton itself peaks at 0.03. The scores
just under 0.5 are the pumpkins (0.415) and, on frame B, the person
(0.476). Lowering `minConfidencePackage` to 0.40 would not draw a box on
this carton. The pumpkin box that does clear the minimum area
(`MinBboxAreaFrac` 0.004 of the zone; the 0.415 box is only 0.0021) is the
0.346 box, still on the pumpkins. The person box is 0.115 of the zone,
about 0.046 of the full frame, which the 0.04 maximum area already rejects.

The model is the wrong detector for this carton at the scale the zone
presents it. It is a confident pumpkin detector (0.92 on a pumpkin crop)
and a weak, fragmented carton detector (0.42, under the floor, only when
the carton fills the input).

## One change

Open a package candidate from scene difference inside the package zone on
the governor look after a person track ends there, and do not require
`rfdetr-package` ≥ 0.5 to accept it.

Frame A is that look: 63 s after the courier track, no person, carton
present. `rfdetr-package` cannot be the classifier of the diff blob. At
zone scale the carton is 0.03, and a tight crop of the carton itself is
0.42 with the box split across the tape and the flaps.

Risk. A still subject is the parked-object registry's, not L1's
([D683](../decisions/adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md),
[D547](../decisions/adr-0547-a-parked-object-is-an-entity-and-its-census-has-a-producer.md)).
The registry's birth bar (N≥8 over ≥120 s) is unreachable at the package
step's cadence, which is why a package already has its own
`PackageStillnessTracker` and does not promote through that registry
([D144](../decisions/adr-0144.md)). The diff candidate has to enter that
tracker as another sighting source. It must not create an L1 track. A
shadow, the door, or a pumpkin that moved will propose a blob, and once
this model is not the gate the remaining controls are "a person track just
ended in this zone" and the area gate. A raw box that still overlaps the
person is not a sighting; the diff has to be the look after the person has
left.
