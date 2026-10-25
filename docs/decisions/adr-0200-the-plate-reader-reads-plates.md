---
id: D200
title: The plate reader reads plates
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-pipeline/python/postprocessors/plate_slots.py
  - packages/addon-pipeline/src/detection-pipeline/pipeline/plate-ocr-crop-policy.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - scripts/build-plate-ocr-model.py
---

## Context

Plate OCR ran on `vgg_english_g2` — EasyOCR's generic English text recognizer.
Every improvement of the last two audits went into giving that model better
pixels, and each one worked: D186 put a floor under sub-legible crops and a
symbol gate over hallucinated punctuation, D198 rectified the plate's own
quadrilateral instead of its bounding box and took exact reads on the cam-102
ground-truth set from 0/21 to 4/21.

D198 also recorded where that line ended. The operator's own car, DN-RO 309,
parked in the driveway with its plate at 180-290 native px — three times the
floor, the largest plate in the set — still read `NOKO309` on every one of its
seven tracks. The `D` disappears into the registration seal, and worse, `NOKO309`
CONFORMS to the German grammar while the old garbage did not. Geometry was
finished; what remained was that the reader had never seen a plate in training.

The obvious move was to swap the model in the same slot. That is not what the
measurements supported. Fed the D198 quad-warped strip, the specialised readers
scored the same 4-5/21 as the incumbent: the warp was not neutral for them, it
was actively wrong. They are trained on what a plate detector emits — an
axis-aligned box around a tilted plate, stretched to a fixed 128×64 without
preserving aspect — which is precisely the input D198 exists to destroy. Fed the
RAW detector box instead, `cct-s-v2-global` jumped to 15/21.

The last five reads were not a recognition problem at all. Every reader tried,
generic and specialised, returned `…RO309` on the Kia: `yolov8n-plate` draws a
box whose left edge lands on the `D`. Growing that box by 15% of its own size —
context the detector never gave — took the Kia from 0/7 to 7/7.

## Decision

The plate-OCR step's default model is `cct-s-v2-global`, a dedicated plate
recognizer, and a plate reader OWNS the three things that describe how it wants
its pixels and how it is doubted. They are declared together in ONE table keyed
by the reader's postprocessor (`plate-ocr-crop-policy.ts`) — margin around the
ROI, whether the rectifier runs, and the minimum crop size — because they are not
independent knobs: rectifying a padded tile, or padding a rectified strip,
produces an input neither reader was ever measured on. A new reader family adds a
row; it never inherits another family's row by default.

The plausibility gate is a property of the DECODE, not of the step. A CTC reader
collapses toward the blank on noise, so "too few characters" is a real signal.
A fixed-slot reader has no blank: it runs ten classification heads and every one
picks a winner, on a plate, a bumper or an OSD weather band, so `minTextLength`
admits literally everything. Its gate is the probability of the WEAKEST emitted
character (`minCharProbability`, 0.75) — not the mean, which six confident glyphs
and one guess still carry to ~0.9 — plus the same region grammar. A read that
fails the grammar is DROPPED rather than kept-and-annotated: this alphabet is 36
alphanumerics and a pad, so it cannot produce the visibly-junk shapes that made
an annotated read worth storing, and a non-conforming read here is a confident
misread.

A recognizer's artefacts ship at **fp32** on every engine. Everything else in the
catalog is fp16 because a box moves a fraction of a pixel and a cosine moves
5e-5; a recognizer's answer is an argmax plus a THRESHOLD, and there is no
accuracy budget between those two to spend.

## Consequences

Measured with the shipped artefact and the shipped postprocessor on the 39-crop
cam-102 set (21 plates / 9 vehicles / 18 junk ROIs, 5 of them illegible to a
human too):

| | exact | char acc | wrong labels | false on junk | invented | Kia |
| --- | --- | --- | --- | --- | --- | --- |
| `vgg_english_g2` + quad-warp | 4/21 | 42.9% | 9 | 0/18 | 0/5 | 0/7 |
| `cct-s-v2-global` + 15% margin | **19/21** | **90.5%** | **0** | **0/18** | **0/5** | **7/7** |

The two silences are the same vehicle at 62 and 66 native px, read CORRECTLY and
then dropped by the confidence floor — the asymmetry the floor is chosen for. On
the independent D186 set of 11 tracks it goes from 1/10 to 4/10 with zero wrong
labels, and in the process proved four of that set's eye-read ground truths
wrong (`DNRB309`/`DNRG359`/`DNRE359` are all one car, `DN RG 309`; `DNXG174` is
`DN KG 176`) — verified by eye on the crops, which is why the older table should
not be trusted against this reader.

What this costs:

- **A second decode path.** `ctc.py` and `plate_slots.py` both exist, with
  different gates, and the step carries both sets of config keys. That is the
  price of keeping `vgg_english_g2` selectable, which it must be: it is the only
  entry that reads non-plate scene text.
- **The warp is now dead code on the default path.** `plate-warp.ts` runs only
  for `ctc`. It is not deleted — it is what makes that reader usable at all, and
  D198's measurements still stand for it.
- **A licence we can defend but not fully audit.** The weights are a release
  asset of the MIT-licensed `ankandrew/fast-plate-ocr`, so `license: 'MIT'` is
  honest; the training corpus is a private dataset the maintainer will not
  release, so the DATA provenance is unauditable and the catalog comment says so
  rather than implying more.
- **Two subsystems now derive the effective postprocessor, and they must not
  drift.** `resolveEffectivePostprocessor` is the single place that answers
  "`modelEntry.postprocessor ?? def.postprocessor`": the engine factory uses it
  to tell the pool which decode to run, the executor uses it to decide which
  pixels to cut. The first wiring had the expression only in the factory, so the
  executor read the STEP's `ctc` and quad-warped the crop for a model the pool
  decoded with the fixed-slot path — 4/21 instead of 19/21, silently. Locked by
  a test that goes red when the resolution falls back to the step.
- **The batch dimension is PINNED to 1, and that is not a detail.** The Intel
  NPU compiler rejects a dynamic dimension outright (`Got negative shape dim
  bound: '-1'` → `ZE_RESULT_ERROR_INVALID_ARGUMENT`), so an operator-pinned NPU
  node never finishes loading the model and retries forever with a fresh pool
  index — loudly in the logs, invisibly in behaviour. Found live on the hub on
  the first deploy of this model, not by reading the spec.
- **Engines will not always agree at the margin.** OpenVINO's CPU default
  inference precision is fp16 and an Intel NPU has no other option, so a marginal
  crop's weakest character moves by up to 0.16 between nodes. fp32 weights remove
  the error we control, not that one. 0.75 was chosen as the centre of the band
  that separates the two populations ACROSS engines, and the build gate enforces
  the invariant that survives it: two engines may disagree on emit-vs-silence,
  never on WHICH plate.

## Enforcement

- `scripts/build-plate-ocr-model.py` refuses to publish unless every engine
  (upstream / patched ONNX / OpenVINO / CoreML) decodes every ground-truthed
  plate identically and no two engines emit DIFFERENT labels on any of the 39
  crops. It also asserts the upstream rescale constant is 1/255 before removing
  the graph's uint8 head, so a retrained upstream fails loudly instead of being
  fed the wrong range, and it pins every shape static so the NPU can compile it.
  Nothing checks the pin AFTER publication: a hand-built artefact with a dynamic
  batch would only show up as a node that never finishes loading.
- `postprocessors/test_plate_slots.py` locks the alphabet contract, the
  weakest-character floor (including that the MEAN cannot rescue a weak glyph),
  the interior-pad refusal and the grammar drop. Verified by sabotage: removing
  the floor, swapping it for the mean, or keeping non-conforming reads each turns
  it red.
- `step-registry-plate-ocr-charset.spec.ts` asserts the DEFAULT model, its
  licence, its postprocessor and the fact that the two readers get opposite
  crops; `plate-ocr-crop-policy.spec.ts` locks the margin arithmetic and that no
  policy ever pairs a margin with the rectifier.
- Nothing checks that a NEW plate model lands in the policy table. It cannot be
  silently wrong — a missing row means no policy, which skips the plate branch
  entirely and is loud — but a wrong row would only show up in an audit.
