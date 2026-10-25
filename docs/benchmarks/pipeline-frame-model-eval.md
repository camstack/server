# Pipeline frame detector evaluation (Task 1)

Generated deterministically from the private benchmark result set.

## Scope and safety

- Private images, model cache, overlays and raw JSON results live under `scratchpad/model-eval/` and are gitignored.
- This report contains aggregate values and corpus ids only; it contains no image bytes, tokens or private cache paths.
- No runtime, capability, model default or production setting was changed.

## Reproduction

```sh
npx tsx scripts/pipeline-frame-model-eval.ts prepare
npx tsx scripts/pipeline-frame-model-eval.ts dry-run
npx tsx scripts/pipeline-frame-model-eval.ts fetch
npx tsx scripts/pipeline-frame-model-eval.ts inspect --python python3.13
npx tsx scripts/pipeline-frame-model-eval.ts transport --iterations 10
npx tsx scripts/pipeline-frame-model-eval.ts benchmark --python python3.13 --warmup 3 --iterations 10
npx tsx scripts/pipeline-frame-model-eval.ts report --python python3.13
```

## Environment

- macOS 26.2; arm64.
- Hardware: Apple M3 Pro.
- Node: v24.17.0; Python: Python 3.13.1; CoreMLTools: 9.0.
- Compute units: ALL (CoreML chooses CPU/GPU/ANE; no private API is used to claim per-op placement).

## Corpus and ground truth

- 4 approved images: 3 misses and 1 positive control.
- Targets: miss-cat-suvfront=cat, miss-bird-sidewalk=bird, miss-cat-t820=cat, control-`the reference plugin`=cat.
- Exact originating bboxes were unavailable. The private manifest therefore records explicit target-region descriptions, not invented coordinates. Recovery is class-presence at threshold; IoU and false-positive counts are unassessed.
- Candidate floor 0.01; comparison threshold 0.20; current animal threshold 0.50; NMS IoU 0.45.

## Artifact inspection

- `scrypted-yolov9c-relu-test`: [Hugging Face tree](https://huggingface.co/scrypted/plugin-models/tree/main/coreml/scrypted_yolov9c_relu_test/scrypted_yolov9c_relu_test.mlpackage); scrypted_yolov9c_relu_test.mlpackage, 48.40 MiB; weight sha256 fe5936b9430ab4c87f30b148220131d6ec998b2377223d033e2fa2a00e60aada; inputs image:imageType[320×320]; outputs var_1867:multiArrayType[1×7×2100]; declared classes {0: 'person', 1: 'vehicle', 2: 'animal'}.
- yolov9m-320: [Hugging Face tree](https://huggingface.co/camstack/camstack-models/tree/main/objectDetection/yolov9/coreml/camstack-yolov9m-320.mlpackage); camstack-yolov9m-320.mlpackage, 76.83 MiB; weight sha256 1c396ded5f2a7b43fc8f08c6b1f8854495fe72a15394f521c0ec79d1cdeb8149; inputs image:imageType[320×320]; outputs var_1763:multiArrayType[1×84×2100]; declared classes 80 classes (COCO metadata).
- yolov9m-640: [Hugging Face tree](https://huggingface.co/camstack/camstack-models/tree/main/objectDetection/yolov9/coreml/camstack-yolov9m-640.mlpackage); camstack-yolov9m-640.mlpackage, 76.90 MiB; weight sha256 1b260e2c17edeedc2d1c55a1d9ffbf66529a6609f1a8e4d69a7576042dfd6591; inputs image:imageType[640×640]; outputs var_1763:multiArrayType[1×84×8400]; declared classes 80 classes (COCO metadata).

## Quality and geometry

- `the reference plugin` / resize (production-equivalent+common-resize): miss-cat-suvfront: target=animal, candidates=1, recovered@0.20=true, best@0.20=0.855, recovered@current=true, best@current=0.855, median/p95=11.037/11.692ms; miss-bird-sidewalk: target=animal, candidates=0, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=5.303/6.115ms; miss-cat-t820: target=animal, candidates=5, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=7.222/7.792ms; control-`the reference plugin`: target=animal, candidates=2, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=10.95/11.707ms.
- `the reference plugin` / letterbox (common-letterbox): miss-cat-suvfront: target=animal, candidates=1, recovered@0.20=true, best@0.20=0.842, recovered@current=true, best@current=0.842, median/p95=10.829/11.048ms; miss-bird-sidewalk: target=animal, candidates=0, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=5.096/5.214ms; miss-cat-t820: target=animal, candidates=9, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=6.717/7.026ms; control-`the reference plugin`: target=animal, candidates=2, recovered@0.20=true, best@0.20=0.412, recovered@current=false, best@current=none, median/p95=12.898/15.405ms.
- yolov9m-320 / letterbox (production-equivalent+common-letterbox): miss-cat-suvfront: target=cat, candidates=5, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=24.278/28.772ms; miss-bird-sidewalk: target=bird, candidates=3, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=19.085/21.069ms; miss-cat-t820: target=cat, candidates=9, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=20.919/22.612ms; control-`the reference plugin`: target=cat, candidates=7, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=33.345/38.026ms.
- yolov9m-320 / resize (common-resize): miss-cat-suvfront: target=cat, candidates=7, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=22.841/28.504ms; miss-bird-sidewalk: target=bird, candidates=25, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=14.373/17.863ms; miss-cat-t820: target=cat, candidates=9, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=13.474/14.662ms; control-`the reference plugin`: target=cat, candidates=7, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=27.699/37.803ms.
- yolov9m-640 / letterbox (production-equivalent+common-letterbox): miss-cat-suvfront: target=cat, candidates=4, recovered@0.20=true, best@0.20=0.482, recovered@current=false, best@current=none, median/p95=33.265/34.332ms; miss-bird-sidewalk: target=bird, candidates=4, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=27.668/28.845ms; miss-cat-t820: target=cat, candidates=11, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=27.571/28.582ms; control-`the reference plugin`: target=cat, candidates=6, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=33.267/33.797ms.
- yolov9m-640 / resize (common-resize): miss-cat-suvfront: target=cat, candidates=10, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=32.807/33.463ms; miss-bird-sidewalk: target=bird, candidates=47, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=28.206/28.85ms; miss-cat-t820: target=cat, candidates=3, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=27.634/28.721ms; control-`the reference plugin`: target=cat, candidates=8, recovered@0.20=false, best@0.20=none, recovered@current=false, best@current=none, median/p95=32.726/33.621ms.
- Annotated overlays were generated privately for every model/preprocess/image combination (24 files).

## Raw/JPEG cost on content-sized frames

- 320×180: raw 168.8 KiB; JPEG median/p95 15.2 KiB/17.8 KiB; raw materialization median/p95 2.877/4.769ms; JPEG encode median/p95 0.901/1.074ms.
- 640×360: raw 675.0 KiB; JPEG median/p95 41.3 KiB/62.1 KiB; raw materialization median/p95 3.338/6.563ms; JPEG encode median/p95 2.214/2.546ms.
- Pool e2e yolov9m-320 320×180 raw: payload median/p95 168.8 KiB/168.8 KiB, median/p95 10.478/11.009ms after warmup.
- Pool e2e yolov9m-320 320×180 jpeg: payload median/p95 15.2 KiB/17.8 KiB, median/p95 10.707/11.467ms after warmup.
- Pool e2e yolov9m-640 640×360 raw: payload median/p95 675.0 KiB/675.0 KiB, median/p95 26.926/31.436ms after warmup.
- Pool e2e yolov9m-640 640×360 jpeg: payload median/p95 41.3 KiB/62.1 KiB, median/p95 27.965/29.323ms after warmup.

## Capacity runner reproduction

- The existing production-path runner is reused without modification through Benchmark → Capacity: upload a positive content frame, resolve an explicit root model, set `targetSize: 106`, `fpsPerCamera: 10`, `settleSec: 30`, `measureSec: 120`, `warmupCalls: 3`, and ramp `2,4,8,12,16,20,24,28,32`.
- Before a real run, pause the measured node with `node scripts/capacity/pause-restore.mjs pause --scope node:<nodeId> --apply`; after it, always run `restore --apply` and `verify`. The UI performs `cacheBenchFrame`, fire-and-poll `runCapacityRamp` / `getCapacityRampStatus`, and frame release.
- CoreML capacity is runnable where the reachable `pipeline-runner` is local. OpenVINO NPU/iGPU on a remote agent is currently blocked: `addons.custom` resolves against the hub registry and refuses proxying custom actions to remote agents, while the runner also rejects a foreign `nodeId` (`packages/addon-benchmark/src/capacity-payloads.ts`). Supplying `nodeId` would not make a remote measurement. <!-- drift-ok: names benchmark code removed by D792 -->
- The result must provide `realConcurrency` and `capacityNMax640`; 640 needs `capacityNMax640 >= ceil(realConcurrency × 1.25)`.
- No capacity result was supplied to this local run; no production node was mutated.

## Decision

- Recommend 640 now: NO.
- Recovered misses at current threshold: 0/3.
- Gate not met: 640 recovered 0/3 misses; at least 2 are required.
- Gate not met: false-positive regression is unassessed because exact ground-truth boxes are unavailable.
- Gate not met: real concurrency or 640 capacity result is unavailable.
- The runtime default remains unchanged; the 2026-08-23 rollout (Task 5)
  confirmed hardware-aware defaults stay `yolov9m-320` / `yolov9m-320-int8`
  and documented the live decode path in
  [`decode-path.md`](../design/decode-path.md) and
  [`data-planes.md`](../architecture/data-planes.md). There is no env that
  promotes 640.

## Limits

- Annotation-only ground truth supports target recovery but not defensible IoU or false-positive regression counts.
- The declared positive control was not recovered at the current 0.50 threshold by either CamStack resolution; the reference NVR recovered it only with common letterbox at 0.20. The control therefore does not validate a 640 promotion in this run.
- CoreML `ComputeUnit.ALL` allows ANE execution but public CoreML APIs do not prove per-operation ANE placement; timings are wall-clock measurements on this Mac.
- The four-image corpus is diagnostic, not a statistically representative accuracy dataset.
- Capacity on live OpenVINO NPU/iGPU and real CoreML concurrency requires the existing quiet-node runner and was not inferred from single-image latency.

<!-- case:miss-dog-101:start -->
## Case `miss-dog-101` — is the animal under threshold, or absent?

Recorded 2026-09-06T17:37:30.222Z on Apple M3 Pro (CoreML). Frames: `miss-dog-101-a`, `miss-dog-101-b`, `miss-dog-101-c`.

- Each frame is a 3840×2160 key frame of camera 101 with a dog in the scene and no `animal` emitted live. The dog box is hand-read at 1/3 scale (±30 px); "overlap" is IoU ≥ 0.30 with that box.
- `native-region` cuts a full-resolution square of at least 640 px around the moving region (padding 0.25) and runs the production 320 letterbox model on it — the second pass of the runner.
- "animals@0.10" lists every animal-class box (COCO animal classes) scoring ≥ 0.10 anywhere in the frame; the overlap column says whether one of them is the dog.

| frame | configuration | animals@0.10 (class:score) | overlaps dog box | best overlapping | median ms |
| --- | --- | --- | --- | --- | --- |
| miss-dog-101-a | `the reference plugin` / resize / full frame | animal:0.74, animal:0.12 | yes (animal 0.74) | 0.74 | 63.658 |
| miss-dog-101-a | `the reference plugin` / letterbox / full frame | — | no | — | 65.099 |
| miss-dog-101-a | yolov9m-320 / letterbox / full frame | — | no | — | 74.496 |
| miss-dog-101-a | yolov9m-320 / resize / full frame | — | no | — | 85.364 |
| miss-dog-101-a | yolov9m-640 / letterbox / full frame | — | no | — | 86.675 |
| miss-dog-101-a | yolov9m-640 / resize / full frame | dog:0.74 | yes (dog 0.74) | 0.74 | 87.972 |
| miss-dog-101-a | yolov9m-320 / letterbox / native-region 1134px | dog:0.35 | yes (dog 0.35) | 0.35 | 20.396 |
| miss-dog-101-b | `the reference plugin` / resize / full frame | animal:0.22 | no | — | 69.751 |
| miss-dog-101-b | `the reference plugin` / letterbox / full frame | — | no | — | 70.242 |
| miss-dog-101-b | yolov9m-320 / letterbox / full frame | — | no | — | 83.006 |
| miss-dog-101-b | yolov9m-320 / resize / full frame | — | no | — | 82.406 |
| miss-dog-101-b | yolov9m-640 / letterbox / full frame | — | no | — | 91.016 |
| miss-dog-101-b | yolov9m-640 / resize / full frame | — | no | — | 90.162 |
| miss-dog-101-b | yolov9m-320 / letterbox / native-region 1267px | — | no | — | 29.521 |
| miss-dog-101-c | `the reference plugin` / resize / full frame | animal:0.89 | yes (animal 0.89) | 0.89 | 70.307 |
| miss-dog-101-c | `the reference plugin` / letterbox / full frame | animal:0.87 | yes (animal 0.87) | 0.87 | 67.218 |
| miss-dog-101-c | yolov9m-320 / letterbox / full frame | dog:0.48 | yes (dog 0.48) | 0.48 | 86.64 |
| miss-dog-101-c | yolov9m-320 / resize / full frame | dog:0.61 | yes (dog 0.61) | 0.61 | 83.167 |
| miss-dog-101-c | yolov9m-640 / letterbox / full frame | dog:0.71 | yes (dog 0.71) | 0.71 | 91.349 |
| miss-dog-101-c | yolov9m-640 / resize / full frame | dog:0.90 | yes (dog 0.90) | 0.90 | 90.548 |
| miss-dog-101-c | yolov9m-320 / letterbox / native-region 1102px | dog:0.90 | yes (dog 0.90) | 0.90 | 22.136 |

<!-- case:miss-dog-101:end -->
