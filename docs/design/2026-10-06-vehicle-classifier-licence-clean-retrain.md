---
title: Vehicle classifier — licence-clean retrain on Open Images
status: proposed
date: 2026-10-06
covers:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-licenses.ts
  - scripts/check-catalog-licence.ts
---

# Vehicle classifier — licence-clean retrain on Open Images

Decision record: [D711](../decisions/adr-0711-the-vehicle-classifier-survivor-is-trained-by-camstack-on-open-images-and-vehicle-type-v1-is-deleted.md)
(proposed). Context: D703 left `vehicle-type-v1` (CC-BY-NC-4.0) as the only
line in `NON_COMMERCIAL_ACCEPTED`.

## Goal

Replace `vehicle-type-v1` with an Apache-2.0 EfficientNet-Lite0 trained on
Open Images V7, same eight labels, no accuracy loss on the hub's own crops.
A Coral build is a later, separate step under D710.

## Steps

1. **Dataset (reproducible).** `scripts/build-vehicle-classifier-dataset.py`: <!-- drift-ok -->
   - Pinned OI V7 `train` / `validation` / `test` box CSVs and
     `oidv7-class-descriptions-boxable.csv`. Classes (verified present):
     Ambulance `/m/012n7d`, Bicycle `/m/0199g`, Bus `/m/01bjv`, Car `/m/0k4j`,
     Motorcycle `/m/04_sv`, Taxi `/m/0pg52`, Truck `/m/07r04`, Van `/m/0h2r6`.
   - Crop from boxes with the pipeline's `crop-roi` geometry (same padding as
     the runtime extract), drop `IsGroupOf=1`, drop crops with a short side
     under 32 px, keep truncated/occluded (camera crops are often both).
   - Hierarchy: Taxi/Ambulance boxes are often duplicated as `Car` (or `Van`)
     on the same object. Deduplicate by IoU ≥ 0.9 within an image and keep the
     most specific label, or the `Car` class absorbs every taxi.
   - Cap per class (Car dominates) and record the per-class counts in the
     dataset manifest. Official OI splits only — no random re-split.
2. **Training.** `scripts/train-vehicle-classifier.py`: timm <!-- drift-ok -->
   `tf_efficientnet_lite0` ImageNet weights (Apache-2.0), NCHW 224,
   `imagenet` normalisation, `resize` preprocess (matches the step), label
   smoothing, light augmentation (no colour shifts that turn a taxi into a car).
   Seed and versions pinned; the run writes its metrics next to the weights.
3. **Export.** Through `scripts/build-camstack-models.py`: ONNX, OpenVINO,
   CoreML, plus `-labels.json` in the existing format. Uploaded to the HF
   `camstack-models` repo under `vehicleClassification/vehicle-type-oi-v1/`.
4. **Evaluation — the gate.**
   - OI `test` top-1 / per-class recall for both models (the old one on the
     same crops).
   - **Real hub crops**: ~200 vehicle crops from tracked `vehicle` detections
     (stored media, read-only), labelled by the operator. The new model must
     match or beat `vehicle-type-v1` top-1, and no class may lose more than
     5 points of recall. Taxi and Ambulance are reported separately (rare,
     regional livery).
5. **Catalog swap (one commit).**
   - New entry `vehicle-type-oi-v1`, licence record reusing `OPEN_IMAGES_DATA`
     and the Lite0 upstream (as `ANIMAL_CLASSIFIER_APACHE`).
   - Delete `vehicle-type-v1` and `VEHICLE_TYPE_V1_NC`; empty
     `NON_COMMERCIAL_ACCEPTED`; add the id to `removed-model-ids.spec.ts`;
     adjust `MIN_ENTRIES` if needed.
   - `defaultModelId` of the step → the new id. D711 → accepted.
6. **Deploy note.** Pipeline addon deploy; rows pinning `vehicle-type-v1`
   become custom ids (D703) and must be re-pointed by the operator.

## Out of scope

- The Coral build (`formats.tflite`): after the swap, under D710
  (normalisation baked, PTQ int8, dequantised logits, parity measured).
- More vehicle classes (pickup, trailer…): a label-set change is a separate
  decision; tier-1 consumers rely on the eight.
