---
id: D645
title: YuNet joins the face-detection catalog as a selectable model, with its input contract baked into every published format and its outputs matched by name only
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/addon-pipeline/python/postprocessors/yunet.py
  - scripts/build-yunet-model.py
---

## Context

`scrfd-2.5g`, the face-detection default, carries InsightFace's
non-commercial terms. The 2026-09-26 replacement spike
(planning repo: superpowers/specs/2026-09-26-replacement-models-spike.md) §2) picked <!-- drift-ok: the spike spec is committed separately, from the main checkout -->
OpenCV Zoo's YuNet 2023mar (weights MIT) and found it does not work out of the
box: **0 faces on 413 person crops**, whether decoded by the production
`scrfd` postprocessor or by a correct YuNet decoder fed the pool's tensor.
Two separate things were wrong:

1. The decode. YuNet has ONE anchor-free prior per cell, a centre + `exp(size)`
   box and a score split across two tensors (`sqrt(cls·obj)`); SCRFD's decoder
   assumes two anchors per cell, distance boxes and one score tensor.
2. The input. YuNet wants BGR 0..255; the pool feeds RGB `/255`.

Wiring it then surfaced a third failure the spike's IR carried: `ov.convert_model`
merges the name of the tensor feeding each output into the output, so `cls_8`
is `{'291', 'cls_8'}`. The pool keys results by `get_any_name()` of the
COMPILED port, and the CPU plugin fuses `Reshape → Sigmoid` differently per
inference precision: it returns `cls_8` under the ARM default (f16) and `291`
under f32, the x86 default. The spike ran on a Mac; every Intel node would have
refused every frame.

## Decision

`yunet-2023mar` is a catalog entry of the `face-detection` step with a
per-MODEL `postprocessor: 'yunet'` override, and it is **not** the step default
(`scrfd-2.5g` stays until YuNet is verified live). Its input contract is
**baked into the graph** (`Mul(255)` then `Gather([2,1,0])` ahead of the first
Conv) and all three formats are converted from that one patched ONNX, so the
entry declares **no** `inputNormalization` — the contract is applied exactly
once on every backend by construction. `postprocessors/yunet.py` matches the
twelve outputs **by name only** and RAISES when one is missing or mis-sized; the
published OpenVINO IR has its internal tensor names cleared so the public name
is the only one a fused port can carry.

Rejected:

- **A new `inputNormalization` value** (`'bgr255'`): it is a
  `z.enum` in `@camstack/types` (a framework package, so a server release), and
  it would need the same change in three places that must agree — the ONNX
  float path, the CoreML multiArray path and the OpenVINO PPP fold (which would
  also need a channel reversal). The bake puts the contract in one artefact and
  is what `auraface-r100` already does.
- **The int8 file plus catalog ships** (100 KB): every number the spike measured was
  on fp32, int8 changed nothing measurable, and a QLinear graph is one more
  thing the OV/CoreML conversions and ORT's execution providers must agree on,
  for 130 KB.
- **A shape fallback in the decoder**, like `scrfd.py`'s: `cls_*` and `obj_*`
  have identical shapes, so a fallback could only guess. Named outputs are
  guaranteed instead (explicit CoreML output names, cleared OV aliases).

## Consequences

- `PostprocessorType` gained `'yunet'`. It is compile-time only (the schema is
  `z.custom`), so an addon built against it runs on a hub whose installed
  `@camstack/types` predates it — the same property `'yolonas'` relies on.
- Re-publishing the artefacts from the raw OpenCV file without the bake gives
  0 faces, silently. `scripts/build-yunet-model.py` is the only supported path;
  its verify stage proves the bake exact against upstream fed `BGR·255`.
- `nmsIouThreshold` applies to YuNet (`NMS_CONSUMING_POSTPROCESSORS`).
- Training data is WIDER FACE (CC BY-NC-ND images), the caveat every public
  face detector carries, SCRFD included. The HF model card says so.
- Making YuNet the default, and removing SCRFD, are later steps (the first
  landed 2026-09-26, below).

## Enforcement

- `postprocessors/test_yunet.py` (unittest, runs on CI's bare interpreter):
  prior layout, decode, landmark order, name matching. The vectorised
  prefilter and the raise-on-missing branch are covered only where numpy is
  installed.
- `__tests__/model-catalogs-yunet.spec.ts`: override present, no pool
  normalisation, formats, licence, NMS knob, and (since 2026-09-26) that the
  onnx/openvino/coreml defaults ARE YuNet while tflite keeps its declared id.
- `scripts/build-yunet-model.py` refuses to finish when the bake is not exact,
  when an OpenVINO output is not named publicly under f32 **and** f16, or when
  a CoreML output name is missing.

## Default since 2026-09-26

`yunet-2023mar` is the `face-detection` `defaultModelId`, on the operator's
explicit go-ahead after a live run on camera 104, where YuNet ran on the hub's
NPU and on its GPU with no errors. Per format: onnx, openvino and coreml resolve
to YuNet. tflite (Coral) has no working face build — YuNet ships none and the
only tflite entry is the `legacy` SSD face stub — so it is DECLARED
(`defaultModelIdByFormat.tflite: 'scrfd-2.5g'`), keeping the id it resolved to
before the flip; `getDefaultModelForFormatFromDef` now lets a declared
per-format id outrank `defaultModelId` when no non-legacy model has a build for
that format, otherwise the declaration would be ignored exactly there. A saved
pin to the retired `scrypted-yolov9t-face` (D643) now lands on YuNet, as every
node that chose nothing does. `scrfd-2.5g` stays in the catalog, selectable and
not legacy; removing it is the operator's call, later.
