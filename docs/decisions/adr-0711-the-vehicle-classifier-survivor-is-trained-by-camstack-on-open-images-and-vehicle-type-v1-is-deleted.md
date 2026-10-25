---
id: D711
title: The vehicle-classifier survivor is an EfficientNet-Lite0 trained by CamStack on Open Images, and vehicle-type-v1 is deleted when it lands
status: proposed
date: 2026-10-06
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-licenses.ts
  - scripts/check-catalog-licence.ts
---

## Context

D703 reduced every enrichment step to one licence-clean model and left exactly
one line in `NON_COMMERCIAL_ACCEPTED`: `vehicle-type-v1`, a MobileNetV3-Large
fine-tuned by CamStack on `DrBimmer/vehicle-classification` (CC-BY-NC-4.0,
read conservatively as binding the weights). It is the last non-commercial model
CamStack ships, and the only step whose survivor is not licence-clean.

The same model blocks a Coral build: MobileNetV3 uses hard-swish and
squeeze-excite, which the Edge TPU compiler maps poorly, and D710 admits a Coral
build only as a format of the survivor. A Coral-only vehicle model is exactly
what D710 forbids.

The animal classifier already shows the way out: EfficientNet-Lite0 (timm,
Apache-2.0) fine-tuned by CamStack on Open Images V7 (CC BY 4.0 annotations,
CC BY 2.0 images). All eight `vehicle-type-v1` classes — Ambulance, Bicycle,
Bus, Car, Motorcycle, Taxi, Truck, Van — are boxable Open Images classes
(verified against `oidv7-class-descriptions-boxable.csv`).

## Decision

The vehicle-classifier survivor becomes an EfficientNet-Lite0 trained by
CamStack on Open Images V7 crops of the same eight classes, under a NEW model id
(working name `vehicle-type-oi-v1`), with the same label set and casing so tier-1
consumers see no change. It replaces `vehicle-type-v1` only when it matches or
beats it on a labelled set of real hub vehicle crops; at that point
`vehicle-type-v1` is deleted (D703 — a deleted id is a custom model, never
retired) and `NON_COMMERCIAL_ACCEPTED` becomes empty.

## Consequences

- CamStack ships no non-commercial model once this lands.
- A pin naming `vehicle-type-v1` becomes a custom id and fails visibly where it
  cannot be served; the operator picks the survivor.
- The training is reproducible from a script in `scripts/` with pinned
  dataset revisions — the only Open Images obligation is attribution, carried by
  the licence record.
- A Coral build of the new survivor is possible later, under D710's admission
  rules; it is not part of this decision.

## Enforcement

- `scripts/check-catalog-licence.ts` fails a non-commercial entry missing from
  `NON_COMMERCIAL_ACCEPTED`; once the list is empty, any NC model fails it.
- `removed-model-ids.spec.ts` gains `vehicle-type-v1` when it is deleted.
- The accuracy gate against real hub crops is a review check, recorded in the
  change that swaps the survivor.
