---
title: Correction beyond the root detector — feasibility step by step
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/**
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/label-utils.ts
---

# Correction beyond the root detector — feasibility step by step

> Status: **plan, no code**. Date: 2026-09-16. Continuation of
> [training-screen.md](training-screen.md) (step 0 shipped, step 1 unblocked
> by [D510](../decisions/adr-0510-the-subject-box-travels-with-the-frame-on-the-media-row.md)).
> ADR number reserved for the architectural decision of this document:
> **D517** — to be written only after the answers in § 7.

The operator's request, verbatim: *"per adesso voglio fare annotazioni del
root detector ma dobbiamo già prevedere correzioni e fine tuning per altri step
della pipeline come classificatori e packages (ad esempio i miei cani che sono
trovati come gatti, o un pacco mancato in ingresso), ovviamente sono da capire
step by step cosa è possibile annotare con i nostri modelli."* [for now I want
to annotate the root detector, but we must already plan for corrections and fine
tuning of other pipeline steps such as classifiers and packages (for example my
dogs that are found as cats, or a package missed at the entrance); obviously we
need to work out step by step what can be annotated with our models.]

The underlying goal: **a set of whole frames, annotated, exportable to external
training tools.** The detector pre-annotates, the user completes.

The short answer, before the evidence:

1. **The existing data model already holds almost everything.** An annotation is
   *(whole frame, canonical box, macroClass, label, subLabel)* and the
   per-model geometries are derived at export
   ([D86](../decisions/adr-0086.md)). For a classifier the "(crop,
   label) pair" is **the same row** seen through `subjectCrop`. No
   second table is needed and none should be created.
2. **On this fleet the step that says "dog" or "cat" is not one: it is two**,
   chosen per camera by which step is switched on. It is the first thing to fix, and it is
   a decision, not a training.
3. **"A missed package" is six gates, of which only one is a model.** The other
   five are parameters that log their own refusal. Annotating before reading
   those logs is wasted work; and the case in which annotating is really needed —
   the model never drew the box — **has no anchor today** in the
   dataset, because without a track there is nothing to mark.
4. **The package is the most fine-tunable step we have** (PyTorch checkpoint on
   HF, upstream that trains); the classifiers and the plate detector **are not** until
   their training checkpoint is found: the catalog only has inference
   exports.

---

## 0. Measured, read, not verified

### Measured on the hub (read-only, `scripts/hub/hub.mjs`, 2026-09-16)

| Question | Call | Answer |
| --- | --- | --- |
| Custom models never come back in? | `customModelRegistry.listModels` | `[]` |
| Which steps run on 101? | `pipelineOrchestrator.resolvePipeline {deviceId:101}` | `object-detection` → `face-detection`→`face-embedding`, `plate-detection`→`plate-ocr`, `clip-embedding`, **`vehicle-classifier`**; separate root **`package-detection`**. **No `animal-classifier`.** |
| Who writes `dog`/`cat` on 101's `animal` tracks? | `pipelineAnalytics.listTracks {deviceId:101, classes:['animal'], limit:50}` | 22/50 labelled, **all with `labelMeta.stepId = 'detector:raw-class'`** (16 dog, 3 cat, 3 bird); 28 without a label |
| …and on 102 / 636 / 637? | same | 102: 10 from **`animal-classifier`** (6 bird, 2 dog, 1 cat, 1 horse) + 3 dog from `detector:raw-class`; 636: 1 dog from `animal-classifier`; 637: 28 from `animal-classifier` (27 dog, 1 cat) |
| Does 101 have a package zone? | `zoneRules.listRules {deviceId:101, stage:'package'}` | yes — rule "Pacchetti" [Packages], `include`, `classFilter:['package']`, `enabled:true` |
| Where are the volumes? | `storage.listLocations {}` | `eventMedia:ssd`, `recordings:recordings-high-4tb`, `recordingsLow:ssd`, `artifacts:default`, 2 `backups`. **No `galleryMedia` row** in the response |
| Does `rfdetr-package` have a training checkpoint? | HF `camstack/camstack-models/packageDetection/rfdetr-package` | **yes**: `camstack-rfdetr-package.pth` (134,960,582 B) + `config.json`, next to onnx/coreml/openvino |
| `yolov8n-package`, `yolov8n-plate`? | HF, same folders | **only** `coreml/ onnx/ openvino/` (+ `tflite/` for the plate). No `.pt` |

### Read in the code and the history

Everything else, with the file alongside. The three readings that matter more than the others:

- **The root's raw class arrives in production, not only at `verbosity:'full'`.**
  `result-assembler.ts` (`toMutableRootDetection`) sets `originalClass:
  det.class` unconditionally and `executor.ts:589` reconfirms it when it
  applies `classMap`; `label-utils.ts` turns it into a tier-1 candidate with
  score 0 and `stepId 'detector:raw-class'`. The comment in
  `step-definitions.ts:138` ("ships only under `verbosity: 'full'`"), the one in
  `label-utils.ts:78` and the entry of (planning repo: sessions/sessions.md) "*Nothing writes <!-- drift-ok: moved to the private planning repo -->
  tier 1 on this fleet*" are **stale**: the measurement on 101 contradicts them. They are
  leftovers of the kind that `CLAUDE.md` says to delete.
- **The crop that a classifier judges is not persisted.** The detail dispatch
  cuts `deriveDetailCropRect(box, convention)` from a decode *subject
  tile* (`detail-subtree.ts`, D52) 2–10 s after the frame, and the tile
  is freed. What remains on the track is `LabelAttribution.decidedAt`
  (the instant) and no reference to the frame or the tile.
- **The export derives the classifier's crop with `CLASSIFIER_CROP_PADDING
  = 0.2`** (`retrain-export.ts`), while the runtime cuts with
  `DEFAULT_DETAIL_CROP_CONVENTION` = `{paddingRatio: 0.15, square: false}`
  (`packages/types/src/pipeline/detail-crop.ts`). The guard
  `scripts/check-clip-crop-single-owner.ts` does not see it because the name is not
  among those it looks for. A classifier trained on 0.2 and queried at
  0.15 is trained on a different distribution.

### Not verified (and how to establish it)

| Claim | Why not verified | How to establish it |
| --- | --- | --- |
| `animal-classifier` (EfficientNet-Lite0, timm) can be retrained from our checkpoint | the catalog only has onnx/coreml/openvino + labels json; I did not look for the `.pt` outside HF | `ls` of the folder `animalClassification/animal-classifier` on HF and of the storage of whoever trained it on 2026-07-19; without a `.pt` one restarts from the timm backbone and the original dataset |
| same for `vehicle-type-v1` (MobileNetV3-L) | same | same |
| `yolov8n-plate` and `yolov8n-package` have a `.pt` somewhere | HF measured: **no** | find it or accept restarting from upstream `yolov8n.pt` |
| RF-DETR fine-tuning: dataset format and API | the README says it trains; the details are on rfdetr.roboflow.com, not read | read the doc and try one epoch on the `.pth` with 10 frames |
| fast-plate-ocr fine-tune from the `cct-s-v2-global` checkpoint | README: "*train models from scratch or fine-tune a pre-trained one*", notebook `examples/fine_tune_workflow.ipynb`; our ONNX has the uint8 head removed (`scripts/build-plate-ocr-model.py`), the keras checkpoint must be taken again from upstream | open the notebook, check that the data format is (crop image, text) |
| SCRFD (face detection) can be retrained | InsightFace has the pipeline, but a non-commercial license and no checkpoint of ours | do not do it: see § 3 |
| `galleryMedia` exists as a location even if `listLocations` does not list it | D197 declares it `defaultRoot:'data'`, `cardinality:'single'`; it may simply not be enumerated | `docker inspect` of the bind or `ls /mnt/mixed/camstack/addons-data/…/galleryMedia`; I did not do it |
| the Retrain page works in a browser | same constraint as training-screen.md § 7 | UI session |

---

## 1. The principle that orders everything: what corrects what

Before the table, the distinction the plan cannot get wrong. Every step
of the pipeline falls into ONE of these four classes, and the class says whether
"annotating" makes sense:

| Class | How it is corrected | Examples here |
| --- | --- | --- |
| **A — model with a labelled dataset** | annotate, retrain outside, re-enters via `registerCustomModel` | root detector, `package-detection`, `plate-detection`, classifiers, `plate-ocr` |
| **B — embedding model** | it is NOT fine-tuned: **examples are enrolled** and the match threshold is adjusted | `face-embedding` (identity-samples), `clip-embedding`, scene-monitor |
| **C — rule** | a parameter is changed; annotating here is a misleading UI | motion, tracker, birth gate, zone, package-drop gate, confidence floor, occupancy |
| **D — out of scope** | no visual annotation makes sense | audio (YAMNet/SoundAnalysis), segmentation |

**An operator correction must be routed to the right class BEFORE being
stored.** "My dog was called a cat" can be A (root or
classifier), but "the package was missed" is almost always C, and only reading
the log says which. The plan therefore does not start from an annotation UI
for everything: it starts from a **per-event diagnosis** that says *which gate*
said no, and offers annotation only when the gate is a model.

---

## 2. The operator's two cases

### 2a. "My dogs found as cats"

**Who decides.** Two steps write the same tier-1 slot (`label`), with the
rule "*in the same tier the highest score wins*" (`label-tier.ts`,
`pipeline-analytics.cap.ts` § tiered label):

| Source | What it produces | Score | On which cameras (measured) |
| --- | --- | --- | --- |
| **root detector, COCO raw class** (`dog`, `cat`, `bird`, `horse`…) | box + class over the whole frame; a single pass at frame-rate | **0** (fixed — "*inherits the detection's standing*") | 101 (all 22 labels), 3 on 102 |
| **`animal-classifier`** (EfficientNet-Lite0, 8 classes, `crop-roi`, `once`, `maxPerTrack 3`, `stickyOnConfidence 0.7`) | label on a crop of the subject | its softmax | 102, 636, 637 |

So: where the classifier is on, it always wins (any score
beats 0); where it is off, tier 1 is the root's raw class. **The same
question has two authorities, selected by a per-camera configuration that
no surface shows as such.** Before annotating a single frame, it must be
decided which of the two is the true one (§ 7, Q1), otherwise a dataset of
"dogs" corrects a model that on half the fleet decides nothing.

**What the correct annotation would be.**

- For the **root**: box + `macroClass: animal` + `label: dog` on the whole
  frame. **Already supported today** (`saveRetrainAnnotations`; `dog` is a
  legitimate label because it is not a macro class). At export `letterbox` is the geometry
  of the root. Completeness: the page annotates every subject in the frame (rule D86).
- For the **classifier**: the **same row**, read as
  `subjectCrop` + `label`. No second crop in the table (D52). Completeness
  for a classifier is trivial: every `animal` box in the frame has a `label`,
  or the row declares `label` absent ("animal, species not known" — which
  today the data model expresses by leaving `label` empty; the export must be able to
  **exclude** these rows from the classifier set, not teach them as an
  "empty" class).

**Is it fine-tunable?**

- Root `yolo26*`/`yolov9*`: **yes, class A** — Ultralytics trains from
  upstream `yolo26n.pt`, and `scripts/build-camstack-models.py` already uses
  `from ultralytics import YOLO` for the exports. The real cost is that a
  fine-tune on 80 COCO classes with a few dozen dogs moves little: it is a
  dataset that is needed at the moment one chooses **a model reduced to the
  home's classes** (person/vehicle/animal + the species that matter), not
  before.
- `animal-classifier`: **class A, checkpoint NOT VERIFIED.** On the catalog
  only exports. If the `.pt` exists, a fine-tune on crops is the cheapest training
  of the whole plan (224×224, 8 classes, minutes on CPU). If it does not
  exist, one restarts from the timm backbone + Open Images, which is a project and not
  a fine-tune.

**What must be captured at the right moment.**

The classifier judged a crop that nobody kept. Three
anchors already exist, none exact:

| Anchor | What it gives | What is missing |
| --- | --- | --- |
| `keyFrame` + `subjectBox` ([D510](../decisions/adr-0510-the-subject-box-travels-with-the-frame-on-the-media-row.md)) | the whole best shot with the box, reconstructible with the convention | it is the instant of the best shot, not `decidedAt` |
| `TrackSnapshot` (filmstrip: whole frame + `position.bbox` + `mediaId`) | whole frames at a cadence with the exact box | the cadence does not coincide with the dispatch |
| `LabelAttribution.decidedAt` | the exact instant of the verdict | no pixels |

Minimal proposal, to be decided (Q3): **a classifier's verdict carries the
`mediaId` of the whole frame from which the tile was cut, when that frame was
persisted (keyFrame/snapshot), otherwise the frame is *parked*
as [D422](../decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)
does for the package** — one whole frame per verdict, `maxPerTrack 3`, not a tile.
The crop stays derived (D52); what is persisted is the frame and the box,
exactly the shape of D510. Without this, the classifier's correction
is made on a crop *similar* to the one judged, which is fine for a dataset
and not fine for a regression test (`kind: 'model_error'`).

**And the shortest road, which is not training.** Before all this, the dogs
mistaken for cats on 102/636/637 must be read with `labelScore`: if the score
of the `cat` verdict is below `stickyOnConfidence` (0.7) the classifier
already retries by itself up to `maxPerTrack`; if it is above, they are ambiguous crops —
and the first thing to look at is **which** frame it judged (see above: nobody
knows). On 101 instead the "cat" is YOLO's raw class on a 320 px frame:
switching the classifier on there is a configuration choice, not a
training.

### 2b. "A missed package at the entrance"

**What it is.** `package-detection` is a **model** (`rfdetr-package`, root
`crop-zone`, floor `minConfidencePackage` 0.5) **under six rules**
([object-detection.md](../architecture/object-detection.md) § package):

| # | Gate | Class | Who logs it |
| --- | --- | --- | --- |
| 1 | the burst opens (motion settle edge near the zone) or the 45 s poll arrives | C | `package-detection dispatched by the motion-settle governor` + `reason` |
| 2 | the model draws a `package` box ≥ the model's floor | **A** | `FrameResult.discarded` (`below-threshold`) — telemetry, not persisted |
| 3 | box ≥ `minConfidencePackage` (0.5) | C | `discarded`, same |
| 4 | seen ≥ `packageDropMinFrames` (3) still (`package-stillness-tracker.ts`) | C | "*An unpromoted candidate that expires logs WHY*" |
| 5 | area in [0.004, 0.04] of the frame (`package-area-gate.ts`, [D205](../decisions/adr-0205-a-package-has-a-plausible-size-and-a-deliverer.md)) | C | same |
| 6 | non-package activity in the zone in the previous 300 s ([D206](../decisions/adr-0206-a-position-that-delivers-itself-is-background.md)) | C | same |

A false negative is corrected by **annotating** only if it died at gate 2. At
gates 3–6 a parameter is corrected, and each leaves a log line with
`tags: {deviceId}`. At gate 1 there is nothing to annotate: the model did not
see the frame.

**What the correct annotation would be (gate 2).** A `package` box on a
whole frame, with the zone crop derived at export
(`deriveZoneCropRect`, `zoneUsed` in the manifest). **Already supported**: the assist
`planAssist({kind:'package', zone})` runs `rfdetr-package` at 0.35 on the zone
crop — i.e. **below** the production floor, which is exactly the way to make the
box that gate 3 discarded re-emerge and turn it into a label.
Completeness: on the zone crop every package is marked; a frame with a package
outside the zone does not enter the package model set (visibleFraction < 1 →
`zoneCrop` absent, already so).

**Is it fine-tunable? Yes, and it is the best case on the fleet.** The `.pth` of
`rfdetr-package` is on HF (measured); RF-DETR trains (README verified,
format/API NOT VERIFIED, see § 0). The model is already "ours" (Apache-2.0), is
opt-in per camera and is not on the frame plane, so an updated model
comes back in without touching the nodes that do not do packages. Same re-entry as
the custom models: `registerCustomModel` + `distributeModel` in
`model-studio-actions.ts` with `stepId: 'package-detection'` and a
`ModelCatalogEntry` that declares `postprocessor: 'rfdetr'` and
`inputNormalization: 'imagenet'` (D208: the picker and the pool read the entry).

**What must be captured — and it is the hole.** A package missed at gate 2 **has no
track**, and without a track:

- it cannot be marked (`setTrackFlags` is a track flag);
- `retrain-frames.trackId` is `NOT NULL`;
- no frame of the burst is persisted: gate 2 left not a single byte.

The only thing that exists is the **recording** (101 is `continuous`, measured in
`docs/benchmarks/2026-09-08-101-dog-on-a-lead.md`), and `recording.readGopBytes`
knows how to return a frame at an instant — it is what that benchmark used. The
missing piece, for the package as for **every false negative of a root step**,
is therefore **a frame source with no track: "this camera, this instant"
from the recording**, which produces a retrain copy as `selectRetrainFrames` produces
it today from a track media. Decision Q2.

`birth-decision-ledger` ([D409](../decisions/adr-0409-a-birth-verdict-is-measured-in-a-bounded-ledger-not-a-log-line.md))
does not help here: it records the birth verdicts (with `sourceTrackId`, `className`,
`verdict`, `reason`) but **no box and no media**; it is the right trace for
false negatives at the *birth gate* (class C) and not for gate 2.

---

## 3. The table per step

Legend: **A** retrainable model · **B** embedding (examples, not
training) · **C** rule · **D** out of scope. "Ckpt" = training checkpoint
available to us. Cost in days, order of magnitude, **repo side only**
(external training is separate, § 5).

| Step | Model (format, provenance) | Correct annotation | Fine-tunable | What must be captured | Cost | What it unlocks |
| --- | --- | --- | --- | --- | --- | --- |
| `motion-wasm`, motion-settle governor | none (WASM diff) | none | **C** — `minArea`/`minAreaFraction`, `maxCoverageFraction` (D394) | already: `rawRegions`, benchmark `motion-region-area.md` | 0 | — |
| `object-detection` (root) | YOLO26 n/s/m/l, YOLOv9 t/s/m/c × {320,640} × {fp32,int8}; Ultralytics, onnx/coreml/openvino; Coral SSD | box + macroClass + label (raw COCO) on whole frame, **all** subjects | **A** — upstream Ultralytics `.pt` base; export script exists | whole frame + box: already (`keyFrame`+D510, snapshot); **the anchor with no track is missing** for the FNs | 0 (annotating) + 2–3 (source from recording, Q2) | the operator's "full frames" dataset; fine-tune sensible only on a reduced-class model |
| small-subject recovery (`small-subject-recovery.ts`) | the same root, on native crops | the same as the root (canonical box; crop `letterbox` derivable) | A via the root; *which crop* is **C** (`motionCropDispatch`) | the recovery's box already travels in the log (D430) and in `TrackPosition.source:'recovery'` | 0 | — |
| `package-detection` | `rfdetr-package` (RF-DETR, **`.pth` on HF**), alt. `yolov8n-package` (export only) | `package` box on whole frame, derived zone crop (`zoneUsed`) | **A** — the best: ckpt + upstream that trains (details NOT VERIFIED) | **nothing** is persisted when the model is silent → the source from recording is needed (Q2); gates 3–6 are C and already log | 2–3 (shared with the root) + 0.5 (per-step export filter) | a package model trained on one's own doorstep; the regression test on `model_error` |
| `PackageDropDetector` + stillness + area + deliverer | rules | none | **C** — `packageDropMinFrames`, `Dwell`, `Min/MaxBboxAreaFrac`, `ActivityWindowSec` | already logged per gate | 0 | — |
| `animal-classifier` | EfficientNet-Lite0, 8 classes, Open Images (2026-07-19); export only | `label` on an `animal` box (= `subjectCrop` at export) | **A, ckpt NOT VERIFIED** | whole frame of the verdict + box (Q3); **export crop convention = runtime** | 1.5–2 (capture) + 0.5 (export with the convention) | dog/cat correction where the classifier decides |
| `vehicle-classifier` | MobileNetV3-L, 8 classes; export only | `label` on a `vehicle` box | **A, ckpt NOT VERIFIED** | as above (same mechanics, zero extra cost) | 0 beyond the animal | van/truck/taxi corrected |
| `bird-classifier` | AIY Birds V1 (MobileNetV2, 965 classes, TF) | `subLabel` (species) on `animal` box | **A in theory, in practice no**: 965 classes, no ckpt, TF | as above | 0 (reuses) | not worth the training; an ambiguity is resolved with `enabledClasses` (C) |
| root raw class as tier 1 (`detector:raw-class`) | it is the root | it is the root | **it is a SECOND AUTHORITY for tier 1** (Q1) | — | 0.5 (decide + a guard) | a single writer per slot |
| `face-detection` | SCRFD 2.5G (InsightFace, non-commercial) / YOLOv9t-face (plugin catalog, UNKNOWN) | `face` box on whole frame (macroClass `face` already exists) | **A in theory; NOT to be done**: license, no ckpt, and the measured defects are of size (`minFaceSize`, `minLandmarkFaceSize`) | — | 0 | annotating face boxes makes sense only as **measurement ground truth** (recall), not for training |
| `face-embedding` | ArcFace R34 (`arcface-r100`, UNKNOWN) / AuraFace R100 (Apache-2.0) | **none**: a sample is enrolled/removed (`identity-samples`, `photo-enroll-actions.ts`) and `similarityThreshold` is adjusted | **B** — already so; "Tienile fuori" [Keep them out] = D197, crop on `galleryMedia` | already captured: vector + crop per sample | 0.5 (a "wrong identity → remove the sample / move it" gesture) | — |
| `clip-embedding` | MobileCLIP S1/S2 (Apple), openvino/coreml | **none** today; personalisation = semantic search, scene-monitor with references | **B** — same; an "animal identity" (my dog) via nearest-neighbour on `object-clip` is **an idea not built**, Q6 | vector per track (`object-embedding-store.ts`) | 0 now | — |
| `plate-detection` | `yolox-tiny-plate` since D719 (open-lpr YOLOX-tiny, Apache-2.0; upstream publishes `best_ckpt.pth`); this row was written for the deleted `yolov8n-plate` (export only) | `plate` box on whole frame (macroClass `plate` exists) | **A** — for `yolov8n-plate` the ckpt was absent (measured): restart from `yolov8n.pt` | like the root | 0 (annotating) | plate recall, with a 102 dataset already in hand from the audit |
| `plate-ocr` | `cct-s-v2-global` (fast-plate-ocr, MIT, private corpus) / VGG g2 | **text** on the plate crop (+15% margin, D200; +5% since D719) | **A** — upstream: "*fine-tune a pre-trained one*" (README verified; format NOT VERIFIED) | already exists: `plate-store.ts` has text + score + `plateCrop`; only the "text corrected by the operator" field is missing → the right ledger is **`vehicle-samples`** (already: normalised text per enrolled vehicle) | 1–2 (export `(plateCrop, text)` from plate rows + vehicle-samples) | a reader that reads the home's plates; but **first**: vehicle enrolment already solves the known cases without training (B-like) |
| zone / birth gate / tracker / occupancy | rules | none | **C** — `zoneMembershipMinOverlap`, `minHits`, D264, D135 | `birth-decision-ledger` (D409) | 0 | — |
| `segmentation`, `instance-segmentation` | U2-Net-P, YOLO26-seg | masks | **D** — nobody corrects them by hand | — | 0 | — |
| `audio-classifier` | YAMNet 521 / Apple SoundAnalysis 303 | label on an audio clip | **D** for this plan (visual); correction = class map/threshold (C) | — | 0 | — |
| scene-monitor | CLIP similarity / vision-LLM | references per condition (day/ir) | **B** — already "enrol examples" | already | 0 | — |

Three rows of the table deserve an extra sentence:

- **Tier 1 has two writers** and the annotation plan inherits the
  ambiguity: a `label: dog` annotated on 101 corrects YOLO, the same on 637
  corrects EfficientNet. The annotation row **must not** carry a
  target `stepId` — it is the frame that is the unit and the derivation at export
  serves both — but the **decision of which step decides** must be taken (Q1).
- **`plate-ocr` is the only step where the annotation is text**, and the retrain
  data model (bbox + 3 tiers) does not represent it. It must not be forced into `subLabel`: the
  ledger that already exists for "text corrected by a human" is `vehicle-samples`,
  and the OCR export is a view over `plate-store` + `vehicle-samples`, not over the
  `retrain-annotations`. Two tables because two questions.
- **Faces and CLIP are not annotated** and any UI suggesting it would lie: the
  correction is one more or one less sample in the gallery, which already exists.

---

## 4. Cross-cutting constraints and how each proposal respects them

**Completeness per frame.** The root and the package inherit it from D86 (one
row per subject, `replaceForFrame`). For the classifiers completeness is
"every `animal`/`vehicle` box in the frame has a `label` **or is excluded from the
classifier set**": the export must distinguish an absent `label` ("I do not know") from
`kind: 'model_error'` ("the model said dog and there is no dog") — today
an empty `label` is already a valid row, but the consumer is not warned.
Addition to the export: for each step a `frames[].annotations` slice filtered
by `macroClass ∈ inputClasses(step)` with an `unlabelled` counter per frame.

**A single authority per datum.**

| Datum | True authority | Second copy to refuse |
| --- | --- | --- |
| canonical box + tier | `retrain-annotations` | any stored crop (D52), any target `stepId` on the row |
| per-model geometry | derived in `retrain-geometry.ts` at export | — |
| classifier crop convention | `DEFAULT_DETAIL_CROP_CONVENTION` / cluster setting | **`CLASSIFIER_CROP_PADDING` in `retrain-export.ts`** — it must be read from the same setting, and the guard extended to the name |
| tier 1 of a track | **to be decided** (Q1) | two writers today |
| corrected plate text | `vehicle-samples` | a `subLabel` on a retrain row |
| face identity | `identity-samples` | — |
| frame with no track (FN) | the retrain copy, with `sourceKind: 'recording'` and an explicit owner (Q2) | a synthetic track created on purpose (`persistSyntheticTrack` exists, but a marker that simulates a track to get around a `NOT NULL` is the second authority in disguise) |

**D52.** No proposal stores a crop. The capture for the
classifier (Q3) persists a **whole frame + box**, i.e. the shape of
D510; the crop is derived at export with the runtime's convention.

**"Tienile fuori" [Keep them out].** The identities already live on `galleryMedia` (D197). The retrain
copies **do not** (`RETRAIN_MEDIA_LOCATION = 'eventMedia'`, footage, destroyed once,
not counted by occupancy — training-screen.md I7). The relocate engine
knows them, so moving them AFTER is possible; but the risk is the wipe *during*
the hours of annotation. **It must be decided beforehand** (Q4), and it is a change of a
constant plus a prefix migration, not a project.

---

## 5. The order, and why

1. **Q1 — a single writer of tier 1** (0.5 d). Without it, every `dog` label
   in the dataset corrects a different model depending on the camera. It is a
   decision + a guard, and depends on nothing.
2. **Q4 — where the copies live** (0.5 d). Before the human hours.
3. **Step 1 of training-screen.md** (the boxes the pipeline actually
   drew) — it remains the first step of code, and it is what makes
   `model_error` annotatable for root and package.
4. **Per-event diagnosis, not annotation** (1 d): a "why not" panel
   that, for a package/animal event, collects the refusal lines already logged
   (gates 1, 3–6; `classifier winner excluded by class filter`;
   `zone membership REJECTED`) and says *class A / class C*. It avoids annotating
   what a threshold wants.
5. **Frame source from recording** (Q2, 2–3 d). It unlocks the false negatives
   of **both** roots (objects and packages), which is the case the operator
   named and which today has no anchor.
6. **Per-step export + crop convention from the setting** (1 d). It makes the tar
   consumable for the package (zone), for the root (letterbox) and for the
   classifiers (the *right* subjectCrop) without touching the table.
7. **Capture of the classifier verdict's frame** (Q3, 1.5–2 d). Only
   after Q1: if the classifier is not the authority, it is not needed.
8. **Assist for classifier** (0.5–1 d): `runStatelessStep` already accepts any
   `stepId` + normalised `bbox`; only `planAssist` for
   `kind: 'classifier'` with `modelId`/`nodeId` resolved as in step 0 is missing.
9. **Plate OCR** (1–2 d): export `(plateCrop, text)` from `plate-store` +
   `vehicle-samples`. Afterwards, because vehicle enrolment already covers the
   home's cases.
10. **Outside the repo**: training script for RF-DETR (1 d, the most mature), for
    Ultralytics (1 d), for the classifier **if** the ckpt exists (1 d);
    re-entry via `registerCustomModel` + `distributeModel` (exists, manual,
    never exercised — training-screen.md M3).

Not in the order and not in the plan: fine-tuning of SCRFD, ArcFace, CLIP, AIY
Birds, YAMNet; a second canvas; a train engine inside CamStack
(a declared non-goal in [model-studio-design.md](model-studio-design.md)).

---

## 6. Costs, summarised

| Block | Days (repo) | Depends on |
| --- | --- | --- |
| Q1 + guard, Q4 + relocate prefix | 1 | — |
| Per-event diagnosis | 1 | — |
| Source from recording (copy with no track) | 2–3 | Q2 |
| Per-step export + convention from the setting | 1 | — |
| Capture of classifier verdict frame | 1.5–2 | Q1, Q3 |
| Classifier assist | 0.5–1 | step 0 (done) |
| Plate OCR export | 1–2 | Q5 |
| **Repo-side total** | **8–11** | |
| External training (package / root / classifier) | 1 / 1 / 1 (+ ckpt search) | dataset |

---

## 7. Decisions that remain with the operator

- **Q1 — CLOSED 2026-10-06 by
  [D715](../decisions/adr-0715-a-root-detector-that-declares-a-step-fills-it-and-tier-1-has-one-writer-per-effect.md):**
  one writer per effect, chosen by the root model's declaration
  (`fillsClassifierEffects`) plus the classifier's `labelLink` policy; a COCO
  root never fills a classifier. The original question follows.
  Who decides the species of an animal: the root detector's raw class or
  `animal-classifier`? If the classifier, it must be switched on on 101 (and across the fleet) and
  the raw class drops to a "suggestion" without writing tier 1; if the root, the
  classifier must be switched off and the training goes on the root. A single answer for the
  fleet.
- **Q2.** Does a false negative with no track enter the dataset as a frame taken
  from the recording at an instant chosen by the operator? If yes, `retrain-frames`
  loses the `NOT NULL` on `trackId` (explicit owner `recording`) — or else the
  dataset stays "tracks only" and the missed packages stay out.
- **Q3.** For the classifiers, is it worth persisting the whole frame of the
  verdict (one per verdict, ≤ 3 per track, D510 shape), or is the
  `keyFrame` enough as an approximation? The first serves the regression test; the
  second is enough for the dataset.
- **Q4.** Do the retrain copies go on `galleryMedia` (data volume, with the
  identities) or on a location of their own? Not on `eventMedia`.
- **Q5.** Does plate OCR enter this plan, or is vehicle enrolment
  (`vehicle-samples`) sufficient for the home's plates?
- **Q6.** Is an "identity" for pets (my dog, recognised by
  CLIP similarity, like faces) desired? It is class B, not training, and it is
  not built.
- **Q7.** Before investing in `animal-classifier`/`vehicle-type-v1`: who has the
  training checkpoints of 2026-07-19? Without them, the cost goes from "fine-tune"
  to "retrain from scratch".

---

## 8. What I did not do

- No mutation on the hub, no `proposeRetrainAnnotations`, no
  tar download.
- I did not open the RF-DETR training doc nor the fast-plate-ocr notebook:
  I only verified that they claim to train.
- I did not look for the classifiers' checkpoints outside HF.
- I did not confirm that `originalClass` arrives on the wire at every level of
  `traceVerbosity` by reading `provider.ts` all the way down: I deduced it from the
  assembler's code and **proved** it with the 22 `detector:raw-class` rows on
  101, which is the proof that counts.
