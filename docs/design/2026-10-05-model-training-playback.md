---
title: Model training from viewer playback
status: proposed
date: 2026-10-05
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/**
  - packages/addon-model-studio/**
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
---

# CamStack model training — playback acquisition & external retrain

## Intent

Close the loop: **pull labelled (or labelable) frames from theater playback**,
export a dataset, retrain outside CamStack, register the result via Model
Studio. Do not build an in-hub training GPU job yet.

## What already works

- Viewer `markForTrain` → staging frames.
- Admin **Events → Retrain**: annotate, export tar
  (`getRetrainExportUrl` / `getTrainingExportUrl`).
- Owner cap: **`pipelineAnalytics`** (not `custom-model-registry`, which is
  read-only `listModels`).
- Post-train path: Model Studio `convertModel` + `registerCustomModel`.

## What is stubbed

- `addRetrainFrameFromRecording` → `still-capture-unimplemented`.
- Named collections cap methods not fully mounted
  (`docs/design/named-training-collections.md`).
- No viewer-side annotation canvas (admin canvas only).

## Trainable targets

| Target | Train? | External tool |
| --- | --- | --- |
| Root OD (yolo26*) | Yes | Ultralytics (AGPL awareness) |
| Package (`rfdetr-package`) | Yes (best fit) | Roboflow / RF-DETR |
| animal / vehicle classifiers | Yes (crops) | timm / Ultralytics + Label Studio or CVAT |
| Face / CLIP / embeddings | No (enrollment / thresholds) | — |

## Cap to extend

**Extend `pipelineAnalytics`** for acquisition + export. Keep Model Studio for
convert/register. Add a `model-training` cap only if we later orchestrate hub
jobs (deferred).

## Acquisition flow (proposed)

```
Theater playhead (deviceId, epochMs)
  → pipelineAnalytics.addRetrainFrameFromRecording
  → recorder still URL / StillFrameService
  → retrain[-collections]/ storage
  → Admin RetrainCanvas / propose annotations
  → getRetrainExportUrl (COCO / YOLO / RF-DETR adapters)
  → Ultralytics | Roboflow | CVAT | Label Studio
  → model-studio convertModel + registerCustomModel({ stepId, entry })
  → customModelRegistry → pipeline picker / Installed Activate
```

## Coupling to detector↔classifier link

Training Q1 (who owns tier-1 labels) must close with
`docs/design/2026-10-05-detector-classifier-label-link.md` before classifier
datasets are trustworthy.

## Ship list

- [x] Wire still-from-playback (remove unimplemented) — D793
- [x] Mount named-collections methods on the cap — D793
- [ ] Align crop padding export ↔ runtime detail crop
- [ ] Export format flags (COCO / YOLO / RF-DETR) + docs
- [ ] Viewer annotate (after collect-and-list is solid)
- [ ] Optional later: hub training job cap

## Related

- `docs/design/training-screen.md`
- `docs/design/named-training-collections.md`
- `docs/design/training-beyond-the-root-detector.md`
