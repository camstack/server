---
id: D661
title: A model's licence lives on its catalog entry, every licence surface is generated from it, and a non-commercial model ships only by name
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - scripts/check-catalog-licence.ts
  - scripts/gen-model-licenses.ts
  - scripts/lib/model-catalogs.ts
  - packages/mcp-dev/src/ops/censuses.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-licenses.ts
  - packages/addon-post-analysis/src/embedding-encoder/catalogs/model-licenses.ts
  - packages/addon-ai/src/runtime/llm-model-licenses.ts
  - packages/addon-model-studio/src/model-licenses.ts
---

## Context

`camstack/server` (MIT) is becoming public, and CamStack downloads more than
eighty models from its own Hugging Face mirror and from third parties. On
2026-09-26 the catalog's `license` field was a bare string, filled on 12 of 77
entries; the mirror had no README and no LICENSE; nothing refused an entry
without terms. The audit (planning repo: superpowers/specs/2026-09-26-model-license-compliance.md) <!-- drift-ok: local, gitignored planning doc -->
re-derived every fact by hand, from ONNX `metadata_props`, upstream LICENSE
files and HF card data, and found three catalog comments that were simply
wrong: the YOLOv9 family was called "ours" (it is Ultralytics' COCO weights,
re-exported), `animals-10` was attributed to the GPL Kaggle dataset (its class
list does not match it), and a plugin catalog face model was said to declare "no
terms" (its repository is tagged MIT, with no per-model terms).

A string cannot say what the obligations are. A permissive CODE licence
routinely sits on restrictive WEIGHTS or DATA (SCRFD: MIT code, InsightFace
non-commercial weights; `vehicle-type-v1`: BSD code, CC BY-NC training data),
and the obligations — attribution, a modification notice, a source offer — are
per upstream. A hand-written notice, the first thing that was tried (Task 1 of
(planning repo: superpowers/plans/2026-09-26-model-license-compliance.md)), was already <!-- drift-ok: local, gitignored planning doc -->
behind the catalog the day SigLIP 2 and YuNet landed.

## Decision

1. **The catalog entry is the record.** `ModelCatalogEntry.license` is a
   `ModelLicense` (`weights`, `code`, `data`, `upstream`, `url`,
   `attribution`, `modifications`, `hosting`, `nonCommercial`). One constant
   per upstream (`model-licenses.ts` in each addon that owns a catalog; addons
   never import each other). A persisted custom-model string still parses,
   lifted into `{ weights }`.
2. **Every licence surface is generated from the records**
   (`scripts/gen-model-licenses.ts`): `THIRD_PARTY_MODELS.md` and its package
   copies, and the model table of the HF card (required attributions verbatim
   — "Built with Llama" and Apple's AMLR sentence among them). Operator-facing
   *Models and licenses* lives in the public docs
   (`camstack/docs` → `/docs/detection/models`), not in the Admin UI
   (operator, 2026-10-04: the Admin page was removed).
3. **The Ultralytics AGPL-3.0 weights are kept** (operator premise
   2026-09-26: the server is public, CamStack stays free and open source).
   Their Corresponding Source is the upstream checkpoint plus the export
   scripts, set out once in the notice's source offer.
4. **A non-commercial model ships only by name**, listed in
   `NON_COMMERCIAL_ACCEPTED` with the reason. Kept today: `scrfd-2.5g`
   (selectable; YuNet is the default since D645), `vehicle-type-v1` (the
   default vehicle classifier, with the CC BY-NC attribution of its data), and
   the four MobileCLIP encoders until MobileCLIP is retired in favour of
   SigLIP 2 (D649).
5. **A legacy entry whose terms cannot be defended is retired, not hidden** —
   `animals-10`, `bird-nabirds-404`, `vehicle-type-efficientnet` — once a
   read-only census (the `model_pin_census` ops tool, `packages/mcp-dev/src/ops/censuses.ts`; it replaced `model-pin-census.mjs`, D835) shows no live pin to
   it. It joins `RETIRED_MODEL_IDS` (D643), so a saved pin runs the step's
   default, which is the entry that replaced it, and is reported as a
   substitution.

### `yolov8n-package`: kept, AGPL-3.0, declared (operator, 2026-09-27)

`yolov8n-package` is Ultralytics YOLOv8n fine-tuned by CamStack: **AGPL-3.0**,
declared as such in the catalog and the notice, its fine-tuning data
unverified. The operator decided on 2026-09-27 to **keep it**, declared, with
the source public — on the same premise as the other Ultralytics weights
(decision 3). What that premise still owes for this model is the part the
notice's source offer already lists as not covered yet: publishing the
fine-tuning checkpoint and recipe. `rfdetr-package` (Apache-2.0) remains the
step's default; `yolov8n-package` stays selectable.

### `arcface-r100`: UNKNOWN, and probably worse than that

Kept as `weights: 'UNKNOWN'` because nothing upstream declares a licence:
neither `onnx-community/arcface-onnx` nor `garavv/arcface-onnx` carries one.
But a 112×112-input, 512-d ArcFace export of this kind is very likely
InsightFace-derived (an MS1M-trained ResNet — the catalog's own inspection
found a ResNet34), and InsightFace releases the models it trains on that data
for **non-commercial research only**. Treat it as possibly non-commercial. It
is selectable and hosted on the mirror, but it is NOT what the cluster runs:
the `clusterModel:face-embedding` row is `auraface-r100` (Apache-2.0, the
default since D651), and `arcface-r100` stays only as the rollback target.
Retiring it is part of any later clean-up of the face line.

### Model Studio's curated catalogs

The pinned plugin catalog YOLOv9 manifest (34 builds) and the plus catalog public catalog
(Coral MobileDet) are lists CamStack writes, not operator uploads, so they carry
records and are walked by the guard like any catalog: every entry must DECLARE
its licence, and Model Studio shows it. Since 2026-10-06 the generator keeps
them OUT of the public notice (`FIXED_STEPS` → `excluded`): they are imported
on the operator's request straight from their publishers, never hosted or
redistributed by CamStack, so the notice names them only in one prose paragraph
under "Your own models", and no public licence surface names a third-party NVR
project's catalog. The
plugin catalog weights are `UNKNOWN` per model with GPL-3.0 code: the ONNX export's
node traces name WongKinYiu's `yolov9` code (`models.yolo.DetectionModel`), not
Ultralytics, and the repository is tagged MIT only at repository level. The
plus catalog MobileDet is Google's Apache-2.0 Coral model. Neither is re-hosted by
CamStack.

### SCRFD alternatives, recorded for the later decision

Facts as verified 2026-09-26; YuNet has since been adopted as the default
(D645), SCRFD stays selectable.

| Candidate | Code / weights licence | Training data | WIDER FACE val (easy / medium / hard) | Landmarks | Notes |
| --- | --- | --- | --- | --- | --- |
| `scrfd-2.5g` | MIT / InsightFace non-commercial research | WIDER FACE | 93.80 / 92.02 / 77.13 (InsightFace, as quoted in the catalog) | 5 | selectable, not the default |
| YuNet 2023mar (`yunet-2023mar`) | BSD-3-Clause training code / MIT weights, "Copyright (c) 2020 Shiqi Yu" | WIDER FACE | 0.884 / 0.866 / 0.750 (opencv_zoo) | 5 | the default since D645: 196 of 204 GT faces found, as many as fixed SCRFD, at 6-7 ms against 33 ms |
| RetinaFace MobileNet-0.25 (`biubug6/Pytorch_Retinaface`) | MIT (repository licence API) | WIDER FACE | not re-checked | 5 | weights linked from the repository README |
| MediaPipe BlazeFace | Apache-2.0 (repository) | Google internal | not comparable (selfie-range model) | 6 | the short-range model does not fit CCTV distances; the full-range model card was not checked |
| Train our own (RF-DETR-N or YOLOX, both Apache-2.0) | permissive | needs a permissively licensed face set; none is known | — | — | 5–10 days |

Every public face detector is trained on WIDER FACE, whose images are CC
BY-NC-ND and whose terms are research-oriented. A swap changes the WEIGHTS
licence, not the data question.

## Consequences

- A new catalog entry cannot land without its licence record, and a
  CamStack-hosted one without the statement of what CamStack changed (Apache
  §4(b), GPL/AGPL §5(a) and the Apple AMLR all ask for it).
- `NON_COMMERCIAL_ACCEPTED` IS the list of accepted non-commercial models.
  Removing a model removes its catalog entry, its line there, and — by the
  operator, separately — its folder on the mirror.
- The generated surfaces are as current as the catalog, and only as TRUE as
  the records: `UNKNOWN` (`arcface-r100`, `inception-resnet-v1`) is an honest
  gap and is shown as one.
- The public docs list CamStack's first-party catalog offer separately from
  Model Studio third-party import surfaces (plugin catalog / plus catalog). A custom
  model's licence is its author's; CamStack does not record it and says so.
- A framework release is needed for `ModelLicenseSchema` to reach a running
  hub (`@camstack/types` travels inside `@camstack/server`).

## Enforcement

- `scripts/check-catalog-licence.ts` (CI guard list): every built-in entry
  declares weights / upstream / url / hosting; a hosted entry states its
  modifications; a non-commercial entry is allow-listed and a stale
  allow-list line fails; one upstream name has one weights licence and URL
  across catalogs; every mirror folder a catalog downloads from has a model
  card.
- `scripts/gen-model-licenses.ts --check`: the notice, its copies and the HF
  table match the catalog.
- `scripts/check-model-notices-shipped.ts`: the packages and the image ship
  the notice, byte-identical.
- `retired-classifier-models.spec.ts`: a saved pin to a retired id runs the
  replacement and is reported.
