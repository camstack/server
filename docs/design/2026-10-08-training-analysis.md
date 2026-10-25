# CamStack model training — consolidated analysis

Date: 2026-10-08. Repo: `camstack-server` as of `main` on 2026-10-08 (viewer submodule `ef5e057a`).
Analysis only. No code, docs, hub state or workflows were touched. Paths are relative to `camstack-server/`.
Live hub counts were **not** re-measured. The last measurement (2026-09-16) was 0 tracks in staging, 0 retrain frames and an empty custom-model registry. Re-check them before planning around the existing corpus (§8 Q0).

**In one paragraph.** The collect, annotate and export half of the loop exists and is decent. It has never been used end to end. The **train** half does not exist in the repo at all: no training script, no dataset converter and no checked-in evaluation harness. The 409-frame pseudo-ground-truth harness behind the per-model floors lives in a session scratchpad. The model-return half (convert, register, distribute) exists but has never been exercised either. The cheapest honest MVP closes the loop once, for the model the fleet actually runs (YOLOv9 m-640). It trains outside the product, on the operator's own machine, and is gated by an evaluation harness checked into the repo plus a shadow replay on recorded sessions. The D711 vehicle classifier is the low-risk companion that proves the same train → export → register → evaluate path without any annotation loop.

## 1. Inventory of prior plans

| # | Plan | Intent | Status | Superseded / contradicted |
|---|---|---|---|---|
| P1 | docs/design/training-screen.md (D509 reserved, never written) | A census of the retrain chain, followed by a 6-step plan: export button, real assist, pipeline boxes on the frame, a shared retrain-core, a viewer canvas and a status badge | **Step 0 done. Steps 1–5 not started** | I8 (orphaned accuracy.ts/mAP) is obsolete: the file is deleted. The YOLO converter it says lives "outside" exists nowhere |
| P2 | docs/design/training-beyond-the-root-detector.md (D517 reserved, never written) | Classifies each step as A (retrainable), B (embedding / enrol), C (rule) or D (out of scope). Covers dog-as-cat and missed packages. Q1–Q7 | **Plan only.** Q1 closed. Q2–Q7 open | Q1 answered by D715 + D736 (the root supplies species, classifiers are on by default and sourced from the root). The plate row was rewritten for yolox-tiny-plate (D719). rfdetr-package is the only package model (model-catalogs.ts:1047-1068) |
| P3 | docs/design/named-training-collections.md + planning repo superpowers/plans/2026-10-03-named-training-collections.md | Admin saves the playhead still into a named collection (V1 collect-and-list) | **Stub.** Task 1 is done. Tasks 2–6 are not | Roadmap :162 says it is "subsumed by training-from-playback" |
| P4 | docs/design/2026-10-05-model-training-playback.md | Closes the loop: playback → export → external training → Model Studio register. No in-hub job | **Proposed. 0 of 6 ship items done** | — |
| P5 | docs/design/2026-10-06-vehicle-classifier-licence-clean-retrain.md + D711 (proposed) | EfficientNet-Lite0 on Open Images to replace CC-BY-NC vehicle-type-v1 | **Not started.** No dataset or training scripts. vehicle-type-v1 is still the default (step-definitions.ts:933) | — |
| P6 | docs/design/2026-10-05-detector-classifier-label-link.md | The root fills a classifier's effect | **Implemented** (D715, extended by D730/D736/D741) | The shipped shape differs from the proposal (run \| skip-when-filled) |

Evidence:
- Export button: admin-ui/components/retrain/RetrainExportPanel.tsx:38-52.
- Restage button removed: pages/Retrain.tsx:30.
- Assist from the server: Retrain.tsx:178-185, 290 (resolveAssistDetector).
- Step 1 not done: RetrainFrameSchema (pipeline-analytics.cap.ts:1355-1367) and RetrainFrameListSchema (:1385-1390) carry no pipeline boxes.
- Step 2 not done: there is no packages/retrain-core, and lib/retrain-boxes.ts:46-118 has draw and hit-test only.
- Step 3 not done: the viewer has only ★ (camstack/src/components/events/track/TrackFlagButtons.tsx:342-351, admin-gated) and a filter chip (EventsFilterBar.tsx:145).
- Step 4 not done: `retrainStatus` appears in no .tsx except a Retrain.tsx docblock.
- The roadmap's "no-zone blocks whole-frame assist" is stale: retrain-assist.ts:19,61,84 run kind 'objects' on the whole frame. Only package without a zone is refused (retrain-service.ts:315-325).
- P3: only declared at pipeline-analytics/index.ts:4365. There are no collection methods among the 13 retrain cap methods (pipeline-analytics.cap.ts:2797-3017). The stub is at retrain-collection-store.ts:189-211.
- Storage: retrain-frame-store.ts:54 `RETRAIN_MEDIA_LOCATION = 'eventMedia'`.
- Padding mismatch: retrain-export.ts:37 0.2 vs the runtime 0.15 (types/src/pipeline/detail-crop.ts).
- Model Studio non-goal: model-studio-design.md:152.

Later decisions that change the plans:

| Decision | Effect on training plans |
|---|---|
| D661/D703 | AGPL Ultralytics weights are kept (free/OSS premise). No AGPL library runs in CamStack (compliance spec :49). An in-product Ultralytics trainer would break this, so training stays external |
| D715/D730/D736/D741 | On YOLOv9 roots the species comes from the root (ROOT_SUPPLIED_LABEL_FLOORS, model-catalogs.ts:757-766), so dog-vs-cat is a root fine-tune problem |
| D738/D739 | Per-model class floors (model-catalogs.ts:708-735, from model-floors.json). A fine-tuned model needs its own row, carried by `ModelCatalogEntry.defaultClassFloors` (types/src/types/models.ts:342) |
| D745 | Auto-tune considers only catalog yolov9* (recommend.ts:44,115) and rewrites the node pin, so it would clobber a custom pin |
| D743 | CoreML exports must be FP16 (Neural Engine) |
| D646 | Session replay compares a model against stored tracks on recorded sessions (addon-benchmark/src/session-replay/compare.ts). This is the shadow evaluator |

## 2. What the system can do today, end to end

| Step | State | Detail |
|---|---|---|
| Mark a whole track | works | ★ setTrackFlags, admin-only. Retention pin and a budget of 500 per camera (track-flags.ts:43) |
| Frame from a recording (false negative, no track) | missing | Stub. The recorder StillFrameService exists (addon-pipeline/src/recorder/still/still-frame-service.ts) but is not wired |
| One-tap false alarm from an event or notification | missing | debug-note presets dropped `falsePositive` (debug-note-presets.ts:20). The NC log has no eventId/trackId |
| Copy-on-select dataset | works | D86. Stored on eventMedia (risk) |
| Annotate | partial | Admin web only. No move/resize/zoom. The canvas opens empty: the pipeline's own boxes are not loaded |
| AI pre-annotation | partial | Re-runs the **production** model at the production floor, or rfdetr-package @0.35 on the zone. No teacher model. The benchmark teachers (YOLO26-X@1280 + RT-DETR-X) live in a scratchpad |
| Export | partial | A tar with annotations.json (canonical + derived geometries) and JPEGs. No YOLO/COCO/RF-DETR format. Wrong classifier padding. No per-step or per-collection filter |
| Versioning / split | missing | No dataset version, split or holdout |
| Train | missing | No training code in the repo. The animal classifier recipe is absent (model-licenses.ts:163-175 says "fine-tuned by CamStack") |
| Convert to ONNX | works | scripts/build-camstack-models.py (Ultralytics recipes). `--model` takes an Ultralytics id and appends .pt (:306-307), so a local checkpoint needs a hack |
| Convert to OpenVINO fp16/int8 | works | Script + Model Studio convert.py:28-46. INT8 is calibrated on COCO val2017. Model Studio `calibrationRef` is never populated |
| Convert to CoreML | works | FP16 (D743), Mac only |
| Convert to TFLite / Edge TPU | partial | One-off scripts only (build-bird-classifier-edgetpu.py, build-yolox-plate-edgetpu.py, build-edgetpu-sets.py, edgetpu_toolchain.py). Model Studio formats are openvino\|coreml (model-studio-actions.ts:133) |
| Register | works, never exercised | registerCustomModel (model-studio.addon.ts:362) takes a full ModelCatalogEntry (floors, labels, postprocessor). Upload actions and distributeModel exist (:587-645). The registry was empty when last measured |
| Deploy | works | Pin a step or node to the custom id (D208). Auto-tune Apply overwrites it |
| Per-model thresholds | partial | The schema supports them. The measurement method is documented, but its scripts are not in the repo |
| A/B offline | partial | Method and results in docs/benchmarks/2026-10-07-detector-comparison.md. Harness not in the repo |
| Shadow on real footage | partial (good) | Per-session replay exists. No batch over many sessions, no rule-aware "false alerts per day" |
| Rollback / versioning | missing | — |

## 3. Training targets, ranked for this fleet

The hub runs yolov9m-640-int8, the N100 runs yolov9s-320-int8, and the Mac runs yolov9m-640 (CoreML FP16 on the ANE). About 28 cameras.

Baseline at the shipped floors on the hub set:

| model | person P/R | small persons | animal P/R | vehicle P/R |
|---|---|---|---|---|
| m-640-int8 | 0.99/0.81 | 24 of 48 | 0.95/0.85 | 1.00/0.83 |
| s-320-int8 | 0.96/0.52 | 6 of 48 | 0.89/0.23 | 0.97/0.51 |

Night recall is 5–15 points lower. Most animal false positives are people labelled dog or cat. Gains below are judgement, not measurement.

| Rank | Target | Pain point | Expected gain | Data | Effort | Risk |
|---|---|---|---|---|---|---|
| 1 | Root YOLOv9 m-640 domain fine-tune, COCO-80 head kept, own frames + hard negatives | plant-as-person on 101 and static phantoms; night and small persons; dog/cat (species supplied by the root, D736); birds as detections | Largest visible gain. Most recurring static FPs removed at the same floor. Recall gains at night and on small subjects | 1.5–3k frames over about 10 cameras (about 30% hard negatives, night/IR, small subjects) + 1–2k COCO replay | Repo 5–8 d. Training 0.5–1 d per iteration | AGPL derivative. Overfit to cameras (needs a time-blocked, per-camera holdout). INT8 recalibration. Floors re-measured. Auto-tune clobber. Three node variants |
| 2 | Vehicle classifier on OI (D711) | licence; unblocks Coral | Parity, licence-clean. On YOLOv9 roots the type often comes from the root, so check how often the classifier runs | Public OI V7 + about 200 labelled hub crops | 3–4 d, fully specified | Low |
| 3 | Plate detector (yolox-tiny-plate, Apache, upstream ckpt) + OCR (fast-plate-ocr, MIT) | plates on 101/102; plates under 110 px | Medium | 300–800 plate boxes; OCR text from vehicle-samples and plate-store | 3–5 d | Small plates may be a crop/resolution (rule) problem. Diagnose first |
| 4 | Package (rfdetr-package, Apache, .pth on HF) | missed packages on 101 | High for one camera, but only 9 package events ever and step timeouts | 100–300 doorstep frames incl. negatives. Needs frames from recording | 2–3 d + weeks of data | Six gates, one model. RF-DETR train API not verified. Slow on Mac |
| 5 | Animal classifier | dog→cat | Low: the root supplies species, and the catalog says "unreliable, no reject class" (model-catalogs.ts:1200) | crops | 1–2 d | Mostly bypassed |
| 6 | Bird species (AIY, 965 classes) | birds | Low. Bird detection is rank 1 | — | — | TF, no ckpt |
| — | Face, CLIP, scene | — | Do not train: enrol examples and adjust thresholds. SCRFD is non-commercial. CLIP needs crop unification + re-index | — | — | — |

Two cheap checks before rank 1:
- Re-measure 101's plant phantom under today's model. It scored 0.5005 under the old default; 101 now runs a YOLOv9 640 variant with person floor 0.55–0.60, and stationary-object suppression is live.
- Diagnose package and plate misses gate by gate.

## 4. Where training runs, and licensing

| Option | Root m-640 fine-tune (2–3k imgs) | Classifier | Notes |
|---|---|---|---|
| Mac M2, MPS | Feasible, many hours to overnight (unmeasured) | minutes | Ultralytics `device=mps`. The ANE serves cameras while training uses the GPU. Check RAM. **Default** |
| Hub CPU | days | fine | Avoid (OOM and I/O history; it is the inference and recording authority) |
| Hub iGPU (XPU) | experimental | — | No |
| NPU / Coral / N100 | inference only | — | — |
| Rented 4090-class (~$0.3–0.7/h) | 1–3 h | — | Fastest. Frames leave the house |
| Colab | 2–5 h | — | Privacy; session limits |
| Roboflow | easy | easy | Free-tier datasets are public. Unacceptable unless on a private paid plan |
| User-supplied trainer | — | — | **Recommended product posture**: export a standard dataset, import ONNX/.pt |

Conversion stays where it already works: OpenVINO/INT8 on x86, CoreML on the Mac, Edge TPU through edgetpu_toolchain.py.

| Base | Licence | Fine-tuned weights | In-product trainer |
|---|---|---|---|
| Ultralytics YOLOv9/YOLO26 (fleet) | AGPL weights and library; YOLOv9 architecture GPL-3.0 | AGPL derivative. Private use carries no obligation. Publishing means AGPL + corresponding source (as D661 does today) | Breaks "no AGPL library in CamStack". Commercial use needs an Enterprise licence. Keep it external |
| WongKinYiu YOLOv9 | GPL-3.0 | GPL | Same conclusion |
| MultimediaTechLab/YOLO | MIT code; weight provenance unverified | possibly clean | Candidate. Verify |
| RF-DETR | Apache-2.0 | Apache | Clean; already the package model; slow on Mac; not Coral-friendly |
| YOLOX | Apache-2.0 | Apache | Clean; used for plates, with an Edge TPU build |
| D-FINE / DEIM / RT-DETRv2 | Apache-2.0 | Apache | Clean; NPU/CoreML behaviour unmeasured |
| timm Lite0 | Apache + OI CC BY | Apache | Clean (D711) |

Implication: the MVP fine-tunes the fleet's YOLOv9 privately with an external trainer, with no new exposure. Publishing weights or adding an in-product trainer is a later decision: either AGPL with the corresponding source, or an Apache trainer.

## 5. The data loop

Sources:

| Source | Today | Needed |
|---|---|---|
| ★ tracks | works | Badge; the pipeline's boxes on the frame |
| False alarms | missing | A one-tap admin "false alarm" on an event or notification that marks the track and **auto-seeds a `model_error` from the stored box** (D510 already carries the subject box on the media row). Highest yield |
| False negatives without a track | missing | P3 Tasks 2–3 + viewer button |
| Bulk recording mining | missing | An offline sampler of day/night stills per camera via the still route |
| Uncertainty mining | missing | Detections in [floor−0.15, floor+0.05], plus production-vs-teacher disagreements |

Annotation:
- Pre-annotate with a large **teacher** offline (YOLO26-X@1280 plus an Apache RT-DETRv2-X or D-FINE-X, with the benchmark's agreement rule), not with the production model. Write the results as `source:'assist'` drafts, then review in admin web.
- Add the pipeline boxes in grey, move/resize and shortcuts. The viewer canvas (retrain-core) comes later; in the MVP the viewer only feeds the loop.
- Keep the COCO-80 taxonomy for root fine-tunes.

Versioning, split, privacy:
- A dataset version is an immutable manifest (frameIds + annotation hashes + export params + teacher ids), stored with the weights and metrics.
- Split by camera and by whole days or tracks, never by random frames. Hold out 2 cameras entirely. Keep a frozen per-camera test set, reported day and night.
- Move retrain storage off eventMedia **before** any labelling.
- Train locally by default. Cloud only by opt-in, with blur where it does not hurt the target.

## 6. Evaluation

| Layer | What | Exists? |
|---|---|---|
| 1 Offline holdout | Per-camera frozen set; P/R/AP50 by class, day/night, small subjects; pipeline-identical preprocess and decode | Method yes; **harness must be checked in** |
| 2 Floors | D739 rule: the lowest floor with ≤ the reference's FP count. Shipped in the registry `defaultClassFloors` | Rule yes |
| 3 False alerts per day | Batch session replay (D646) over N days on target cameras, counting tracks that pass the floor and match a live NC rule's zone and class, vs production | Single-session replay only. Needs batching, rule-aware counting and NC provenance |
| 4 Shadow | Nightly replay of the day's sessions (cheap); a live dual root is optional | Replay yes |
| 5 Canary | Pin on 101 for a week vs the previous week and a control camera | Pinning yes; auto-tune must not overwrite it |
| 6 Fleet | m-640 CoreML FP16 (Mac), m-640-int8 OV with **own-frame** INT8 calibration (hub), N100 stock or a separate s-320 fine-tune | Convert yes; auto-tune needs a custom-pin rule or perf rows |

Promotion gate (proposal):
- Person recall at the new floor is ≥ baseline − 0.01 on every camera.
- Night or small-subject recall improves by ≥ 0.03.
- Replayed false alerts per day drop by ≥ 30% on target cameras.
- No camera gets worse by more than 1 alert per day.

## 7. Phasing

| Phase | Deliverables | Effort | Depends on |
|---|---|---|---|
| 0 | Answers to Q1–Q5; durable retrain storage; live census + 101 phantom check; export padding fixed to 0.15 | 1–2 d | Operator |
| **1 MVP** | (a) Evaluation harness checked in (scripts/eval/). (b) False-alarm capture: Step 1 (pipeline boxes) + one-tap false alarm that seeds a model_error. (c) External training kit (tools/training/ or a separate repo): export→YOLO, COCO replay mix, Ultralytics MPS/CUDA recipe, manifest. (d) `build-camstack-models.py --checkpoint <path>` → ONNX, OV fp16/int8 (own-frame calibration), CoreML FP16 + a registry-ready entry with measured floors. (e) Register, 7-day batch replay, canary on 101. (f) Auto-tune skips or warns on nodes with a custom root pin | 7–10 d + 2–3 d training and evaluation | Phase 0 |
| 1b | D711 vehicle classifier (reuses a and d) | 3–4 d | Q6 |
| 2 | P3 Tasks 2–3 + 5 (frame from recording, named collections, viewer add-frame); teacher pre-annotation; admin move/resize/zoom; per-step and per-collection export + YOLO/COCO adapters; uncertainty mining | 6–9 d | Phase 1 shows value |
| 3 | Plate box + OCR fine-tunes; package after ≥100 annotated frames and gate diagnosis; "why not" panel | 5–8 d + data time | Phase 2 |
| 4 | retrain-core + viewer canvas; custom-model revisions and rollback; auto-tune perf rows for custom models; optional hub training-job cap with an Apache trainer only | 10+ d | Q1 |

## 8. Open questions

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q0 | Is there any annotated data on the hub today? | re-measure / assume zero | Read-only census (listRetrainStaging, countUnstampedEventMedia, customModelRegistry.listModels) |
| Q1 | Licence posture | private AGPL fine-tune / publish AGPL + source / Apache trainer | Private for the MVP; decide later |
| Q2 | Compute | Mac M2 / rented GPU / Colab / hub | Mac M2; rented GPU for m-640 if too slow; never the hub |
| Q3 | Frames leaving the house | never / opt-in + blur / free | Never for the MVP |
| Q4 | Retrain storage | galleryMedia / dedicated / eventMedia | Dedicated durable location, counted by occupancy |
| Q5 | First target | root / D711 / plates / package | Root m-640 hard-negative fine-tune, with D711 in parallel |
| Q6 | D711 go-ahead | accept / defer | Accept |
| Q7 | Class set | COCO-80 / reduced | Keep 80 for now |
| Q8 | Nodes | m-640 only / also s-320 | m-640 first (hub + Mac) |
| Q9 | False negatives without a track | from recording / tracks only | Yes, from recording |
| Q10 | Auto-tune vs custom models | skip + warn / perf rows / ignore | Skip + warn now; perf rows later |

Unverified:
- MPS and cloud timings.
- The licence of MultimediaTechLab/YOLO weights.
- RF-DETR's fine-tune API.
- Pseudo ground truth is model agreement, not human labels.
- Package step timeouts (August) need re-checking.
- Every status above was read from code, not from comments.
