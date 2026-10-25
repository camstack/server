# Model Studio — local catalog of the reference NVR's YOLO models

## Goal

Add to Model Studio a `reference-nvr` tab that exposes only the YOLO and YOLO test detectors published in the public Hugging Face repository `reference-nvr/plugin-models`. The tab uses generic selectors derived from a local manifest and reuses the download, registry, per-node availability, distribution and conversion already present in Model Studio.

Face, segmentation, VGG, CLIP and CRAFT are explicitly excluded. No generic Hugging Face browser is added, and no labels or postprocessor are inferred from unknown artifacts.

## Labels and macro mapping

### The verified reference NVR

The reference NVR's YOLO detectors in the catalog use the three macro classes directly, in the same order:

```text
0 person
1 vehicle
2 animal
```

The taxonomy is confirmed by the CoreML/ONNX `names` metadata, by the reference OpenVINO implementation, by the labels file used by the TFLite runtime and by the CoreML benchmark output `[1, 7, 2100]` (4 coordinates + 3 classes).

Each manifest entry therefore declares these labels and an identity class map towards the CamStack macros.

### The reference detector today

The public catalog of the reference detector declares its COCO-91 labelmap. The CamStack SSD postprocessor uses the COCO-90 aligned to the model's indices and produces the raw classes; the step's `COCO_TO_MACRO` keeps person, vehicles, animals and the proxy packages, discarding the rest.

The reference detector+ instead imports the ordered labelmap returned by the API. The classes that match the `COCO_TO_MACRO` keys work; any unmapped custom classes are today discarded with a warning. There is no operator-configurable end-to-end custom mapping.

### Gap in the custom model contract

`custom-model-registry` carries a `CustomModelDescriptor` with a `ModelCatalogEntry`, but `ModelCatalogEntrySchema` does not contain `classMap`. A TypeScript field `CustomModelMetadata.classMap` exists, not connected to the cap, the registry or the runtime. The effective mapping today is the global one of the `object-detection` step.

The follow-up completes the contract:

- adds `ClassMapDefinitionSchema` and `ModelCatalogEntry.classMap?`;
- resolves for each root `effectiveClassMap = modelEntry.classMap ?? stepDefinition.classMap`;
- passes the effective map to the executor, warning/applicability and result assembly without mutating the step's shared definition;
- preserves `classMap` during conversions and format merges;
- uses for the reference NVR an identity map `{ person: person, vehicle: vehicle, animal: animal }` with `preserveOriginal: false`;
- leaves the public reference detector on the `COCO_TO_MACRO` fallback;
- allows a future custom reference-detector+ import to declare an explicit mapping, without inventing it automatically.

## Acquired source structure

The local manifest represents the axes observed in the HF tree:

- family/size: `yolov9t`, `yolov9s`, `yolov9m`, `yolov9c`;
- variant: `relu` and `relu_test`;
- supported CamStack format:
  - CoreML `.mlpackage`: `c`, `m`, `s`, `t`, normal and test;
  - ONNX: `c`, `m`, `s`, `t`, normal and test;
  - OpenVINO FP32: `c`, `m`, `s`, `t`, normal;
  - OpenVINO INT8: `c`, `m`, `s`, `t`, normal and test;
  - TFLite 320: only `yolov9s_relu_sep_320`, with float16, float32, int8,
    integer quant, **full_integer_quant** (real artifact on the pin) and EdgeTPU.

The NCNN artifacts present on HF do not enter the manifest because CamStack's `ModelFormat` does not support NCNN. The excluded directories are not returned to the client.

## Architecture

### Local manifest

A `reference-nvr/` module contains declarative, immutable entries. Each entry includes:

- stable CamStack ID and label;
- family/size, test/non-test variant, format and precision;
- relative HF path, declared size and multi-file payload;
- input size verified **320×320** on all 34 entries of the pin
  (OpenVINO XML 12/12, CoreML 8/8, ONNX 8/8, TFLite 6/6);
- preprocess **`resize` (stretch)**: the reference NVR's default is an RGB resize to the
  square. `settings.pad` is opt-in and is **not** equivalent to the CamStack
  letterbox; fill/pad stay out of scope. CamStack must use `resize`
  for equivalence;
- verified output `[1, 7, 2100]`, labels `person/vehicle/animal`,
  cxcywh parse;
- explicit YOLO postprocessor, ordered labels and class map;
- runtime/hardware compatibility;
- any notes.

The code builds URLs exclusively with the fixed repository `reference-nvr/plugin-models` and a configured revision, without accepting arbitrary hosts or paths from the client.

### Discovery and drift check

The runtime does not use the HF tree as a metadata source. A read-only parser compares the remote tree with the local manifest periodically or on explicit action:

- reports new, missing or size-changed YOLO artifacts;
- does not automatically import unmapped entries;
- allows updating the manifest in a reviewable and testable way.

This keeps selectors updatable without turning Model Studio into an untyped remote importer.

### Backend

Two custom actions:

- `listPluginCatalogCatalog`: returns the projection of the manifest and the drift state;
- `importPluginCatalogCatalogModel`: accepts only a `manifestId`, resolves URL and payload server-side, downloads, validates and registers.

The import:

1. validates that the entry is in the manifest;
2. downloads into staging with a size limit;
3. verifies that it is not an LFS pointer and checks expected bytes/checksum when available;
4. handles CoreML directories and OpenVINO XML+BIN atomically;
5. registers `CustomModelDescriptor` and hub availability;
6. reuses `model-distributor` for agents and `model-convert` only when requested.

No URL passed by the UI is dereferenced.

### UI

`page.tsx` adds a fourth tab for the external catalog. `PluginCatalogTab.tsx` presents a cascade:

1. family/size (`T`, `S`, `M`, `C`);
2. variant (`Standard`, `Test`);
3. runtime/format (`CoreML`, `ONNX`, `OpenVINO`, `TFLite` if available);
4. precision/quantization;
5. available input size.

The final card shows size, bundle files, compatible runtimes, already-imported state and drift. The `Import` button uses the typed action; state, errors and retry follow the existing reference-detector patterns.

## Error handling and security

- repository, host and revision are server-owned;
- relative paths normalized, with no `..`, leading slash or symlink;
- payloads not declared in the manifest rejected;
- download with atomic staging and cleanup on error;
- CoreML requires `Manifest.json`, model and weight declared;
- OpenVINO requires sibling XML and BIN;
- a size out of tolerance or LFS pointer content produces an explicit error;
- a remote drift does not break the already-known local catalog, but disables the import of the diverging entry until verified.

## Tests

TDD with RED tests before the implementation:

- the tree parser filters only YOLO/YOLO test and ignores face, seg, VGG, CLIP, CRAFT and NCNN;
- the manifest covers all the observed supported combinations without duplicates;
- all 34 entries declare `inputSize` 320×320 and `preprocessMode: 'resize'`
  (letterbox forbidden on this catalog);
- every reference NVR variant exposes exactly `person`, `vehicle`, `animal` and maps them identically to the macros;
- a custom model with an identity macro map does not lose `vehicle`/`animal` in the step's COCO class map;
- a custom model without an override keeps the current reference-detector/COCO behaviour;
- conversion and format merge preserve the mapping;
- URLs/paths cannot escape `reference-nvr/plugin-models`;
- CoreML/OpenVINO produce complete multi-file payloads;
- the import rejects an unknown ID, drift, LFS pointer and invalid size;
- actions register the correct descriptor/availability without client URLs;
- tab and filters produce only valid combinations;
- already-present import, error and retry are represented correctly.

## Non-goals

- generic import of every Hugging Face file;
- NCNN support;
- face, segmentation, VGG, CLIP or CRAFT models;
- auto-inference of labels/preprocess/postprocessor from unknown artifacts
  (the 320×320 / `resize` metadata of this catalog are verified on the pin,
  not inferred);
- the reference NVR's fill/pad (`settings.pad`) as an equivalent of the CamStack letterbox;
- changing the detector defaults or the pipeline during this follow-up.
