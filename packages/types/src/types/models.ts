import { z } from 'zod'
import type { ClassMapDefinition, LabelDefinition } from './labels.js'
import { DetectionCatalogClassMapSchema, LabelDefinitionSchema } from './labels.js'
import type { PostprocessorType } from './pipeline-step.js'
import { ClipModelMetaSchema } from './clip-model.js'
import {
  CROP_SUPPLY_STEP_IDS,
  LABEL_SUPPLY_STEP_IDS,
  MASK_SUPPLY_STEP_IDS,
} from '../catalogs/root-model-supply.js'

import { MODEL_FORMATS } from './model-formats.js'
import type { ModelFormat } from './model-formats.js'

export { MODEL_FORMATS }
export type { ModelFormat }
export type ModelOutputFormat =
  | 'yolo'
  | 'ssd'
  | 'embedding'
  | 'classification'
  | 'ocr'
  | 'segmentation'

/**
 * Multi-file format payload.
 *
 * - Directory formats (`isDirectory: true`, e.g. `.mlpackage`): files
 *   relative to the directory root — the downloader fetches each from
 *   `{url}/{file}` into `{modelDir}/{file}`. If omitted, it probes the
 *   HuggingFace API (slower).
 * - Single-file formats (no `isDirectory`, e.g. OpenVINO IR): sibling
 *   files fetched from the SAME remote directory as `url` and stored flat
 *   alongside the main file — e.g. `['camstack-yolov9t.bin']` for the IR
 *   weights next to `camstack-yolov9t.xml`.
 */
export const ModelFormatEntrySchema = z.object({
  url: z.string(),
  sizeMB: z.number(),
  /** Whether this format is a directory bundle (e.g., .mlpackage) rather than a single file */
  isDirectory: z.boolean().optional(),
  /** Multi-file payload (directory members or sibling files). */
  files: z.array(z.string()).readonly().optional(),
  /** Runtime(s) that can use this format. If omitted, inferred from ModelFormat key */
  runtimes: z
    .array(z.enum(['python']))
    .readonly()
    .optional(),
  /**
   * Content revision of the artefact, for one hosted OFF the CamStack mirror.
   * A format on the mirror leaves it unset: its revision (the sha256 of its
   * weight file) comes from the downloader's generated table, kept in step
   * with the mirror by `scripts/check-hosted-model-revisions.ts` (D744). A
   * node records the revision it downloaded next to the file
   * (`<file>.revision`); a copy with no record or a different one is stale
   * unless its weight file hashes to the revision, and a stale copy is
   * downloaded again, the old one serving until the new one is complete. No
   * revision at all ⇒ a file on disk is current, whatever it holds (D743).
   */
  revision: z.string().min(1).optional(),
})

export type ModelFormatEntry = z.infer<typeof ModelFormatEntrySchema>

/**
 * What a node holds for one (model, format) (D746). `current` is a complete
 * copy at its catalog revision — exactly what `downloaded: true` means.
 * `stale` is bytes on disk that are not (yet) proven current under D743/D744:
 * no or a different revision record, or a missing sibling. `missing` is no
 * copy. `downloaded` alone folds `stale` into "not downloaded", which hid
 * reclaimable bytes and a copy about to be replaced.
 */
export const ModelOnDiskStateSchema = z.enum(['current', 'stale', 'missing'])

export type ModelOnDiskState = z.infer<typeof ModelOnDiskStateSchema>

/**
 * The numeric precision of one format's BUILD (D746) — reported only when the
 * build states it (file-name token, an INT8 variant, an EdgeTPU compile, a
 * CamStack Core ML export). Absent means "not stated", never "fp32".
 */
export const ModelFormatPrecisionSchema = z.enum(['fp32', 'fp16', 'int8'])

export type ModelFormatPrecision = z.infer<typeof ModelFormatPrecisionSchema>

/**
 * One format of one model as a node's `pipelineExecutor.getSchema` reports it.
 * `onDisk` / `precision` are optional for version skew: a runner that predates
 * them omits them, and a reader falls back to `downloaded`.
 */
export const PipelineModelFormatStatusSchema = z.object({
  downloaded: z.boolean(),
  sizeMB: z.number(),
  onDisk: ModelOnDiskStateSchema.optional(),
  precision: ModelFormatPrecisionSchema.optional(),
})

export type PipelineModelFormatStatus = z.infer<typeof PipelineModelFormatStatusSchema>

/**
 * Extra file that must be downloaded alongside the model (e.g., labels JSON, dict.txt).
 * The downloader fetches from `url` and saves to `{modelsDir}/{filename}`.
 */
export const ModelExtraFileSchema = z.object({
  url: z.string(),
  filename: z.string(),
  sizeMB: z.number(),
})

export type ModelExtraFile = z.infer<typeof ModelExtraFileSchema>

/**
 * Per-format payload map. Modelled as an explicit object (one optional key
 * per `ModelFormat`) rather than `z.record(enum, …)` — zod v4's enum-keyed
 * record requires every key, but a catalog entry only ships a subset of
 * formats.
 */
export const ModelFormatsSchema = z.object({
  onnx: ModelFormatEntrySchema.optional(),
  coreml: ModelFormatEntrySchema.optional(),
  openvino: ModelFormatEntrySchema.optional(),
  tflite: ModelFormatEntrySchema.optional(),
  pt: ModelFormatEntrySchema.optional(),
  gguf: ModelFormatEntrySchema.optional(),
})

/**
 * Variant-selector grouping axes. Shared by the full `ModelCatalogEntry` and by
 * the reduced `PipelineModelOption` returned in `pipeline.getSchema()` so the
 * grouped Family→Tier→Variant picker renders identically in the config UI and
 * in the pipeline/device steppers. The flat `id` stays the source of truth for
 * resolution/download/persistence; this is a presentation overlay resolved back
 * to an `id`.
 */
export const ModelVariantGroupSchema = z.object({
  /** Top-level family, e.g. `yolo26` (later `d-fine`, `rf-detr`). */
  family: z.string(),
  /** Size within the family, e.g. `n` | `s` | `m` | `l`. */
  tier: z.string(),
  /** Quantization axis. Omit ⇒ the fp32 base build. */
  precision: z.enum(['fp32', 'int8']).optional(),
  /**
   * Training / latency-variant axis. Omit ⇒ the standard build. `test` marks
   * an alternate training of the same family (plugin catalog `relu_test`); chip
   * label is "Test".
   */
  optimization: z.enum(['standard', 'test']).optional(),
  /**
   * Input-resolution axis (square input side, px). Omit ⇒ the family's native
   * resolution (640 for yolo26). Reduced-input builds (320 / 256) are a big,
   * cheap latency lever — especially on Apple ANE and the Intel N100 — at a
   * small-object accuracy cost. Mirrors the model's `inputSize` but lifted onto
   * the group so the selector can offer it as a variant axis.
   */
  resolution: z.number().int().positive().optional(),
})

export type ModelVariantGroup = z.infer<typeof ModelVariantGroupSchema>

/**
 * Where a catalog entry came from. The pipeline stepper partitions the picker
 * by this id (CamStack / plus catalog / plugin catalog / Custom). Absent on older durable
 * registry rows — {@link inferModelProvider} fills it at read time. Built-in
 * catalog entries omit it and `getSchema` treats them as `camstack`.
 */
export const MODEL_PROVIDER_IDS = ['camstack', 'frigate', 'scrypted', 'custom'] as const
export const ModelProviderIdSchema = z.enum(MODEL_PROVIDER_IDS)
export type ModelProviderId = z.infer<typeof ModelProviderIdSchema>

export interface InferModelProviderInput {
  readonly id: string
  readonly provider?: ModelProviderId
  readonly description?: string
}

/**
 * Resolve a catalog entry's picker provider. An explicit stamp always wins;
 * otherwise plus catalog/plugin catalog are recognised from id prefix or description.
 * Unstamped BYO registry rows fall through to `custom`. Family `yolov9` is
 * NOT a plugin catalog signal — CamStack ships that family too.
 */
export function inferModelProvider(entry: InferModelProviderInput): ModelProviderId {
  if (entry.provider !== undefined) return entry.provider
  const haystack = `${entry.id} ${entry.description ?? ''}`
  if (/scrypted/i.test(haystack)) return 'scrypted'
  if (/frigate/i.test(haystack)) return 'frigate'
  return 'custom'
}

export const MODEL_HOSTING = ['camstack-hf', 'third-party', 'built-in'] as const
export type ModelHosting = (typeof MODEL_HOSTING)[number]

const ModelLicenseRecordSchema = z.object({
  /** SPDX id of the WEIGHTS' terms, a `LicenseRef-*` for non-SPDX terms, or `UNKNOWN`. */
  weights: z.string().min(1),
  /** SPDX id of the upstream code that defines / trained the network. */
  code: z.string().min(1).optional(),
  /** Training data whose terms add obligations (attribution, non-commercial). */
  data: z
    .object({
      name: z.string().min(1),
      terms: z.string().min(1),
      url: z.string().url().optional(),
    })
    .optional(),
  /** The project the weights come from. Required on built-in entries (guard). */
  upstream: z.object({ name: z.string().min(1), url: z.string().url() }).optional(),
  /** Where the licence text governing the weights is published. */
  url: z.string().url().optional(),
  /** Attribution the licence REQUIRES, verbatim. */
  attribution: z.string().min(1).optional(),
  /** What CamStack changed. Required when `hosting` is `camstack-hf` (guard). */
  modifications: z.string().min(1).optional(),
  /** Who serves the file a node downloads. */
  hosting: z.enum(MODEL_HOSTING).optional(),
  /** True when the weights or their data forbid commercial use. */
  nonCommercial: z.boolean().optional(),
})

/**
 * The licence of a model, as a record rather than a bare SPDX string: a
 * permissive CODE licence routinely sits on top of restrictive WEIGHTS or
 * DATA, and the obligations (attribution, modification notices, source offers)
 * are per upstream. A persisted custom-model row written when this field was a
 * string still parses — the string is lifted into `{ weights }`.
 *
 * Every machine licence surface (`THIRD_PARTY_MODELS.md`, the Hugging Face
 * model table) is GENERATED from these records by
 * `scripts/gen-model-licenses.ts` (D661). Operator-facing docs live in
 * `camstack/docs` → `/docs/detection/models`.
 */
export const ModelLicenseSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { weights: value } : value),
  ModelLicenseRecordSchema,
)
export type ModelLicense = z.infer<typeof ModelLicenseSchema>

/**
 * One step a ROOT detector can supply from its own output (D730) — see
 * `ModelCatalogEntry.suppliesSteps`.
 *
 * - `label`: the root's raw class IS the step's answer. `labelToEffect` maps
 *   the root's label to the step's vocabulary; `uncovered` is the vocabulary
 *   the root cannot produce (shown as unavailable, never a blocker).
 * - `crop`: the root draws the box the step would have found (`license_plate`
 *   for plate-detection, `face` for face-detection). The box becomes a detail
 *   child of the `parentMacro` detection that contains it — never a track.
 * - `mask`: the root's decode emits an instance mask with every detection (a
 *   YOLO26-seg root, D737) — the `segmentation` step's result, carried on the
 *   detection in the shape that step produces. Derived from the model's
 *   postprocessor on read, never stored by an import.
 */
export const RootStepSupplySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('label'),
    stepId: z.enum(LABEL_SUPPLY_STEP_IDS),
    labelToEffect: z.record(z.string(), z.string()),
    uncovered: z.array(z.string()).readonly(),
  }),
  z.object({
    kind: z.literal('crop'),
    stepId: z.enum(CROP_SUPPLY_STEP_IDS),
    rootLabels: z.array(z.string()).readonly(),
    parentMacro: z.enum(['vehicle', 'person']),
    childClass: z.enum(['plate', 'face']),
    /**
     * The root's smaller input side, stamped on read by `rootSuppliesOf` from
     * the model entry — what a step's `minRootInputPx` gate judges. Never
     * stored by an import.
     */
    rootInputPx: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('mask'),
    stepId: z.enum(MASK_SUPPLY_STEP_IDS),
  }),
])
export type RootStepSupply = z.infer<typeof RootStepSupplySchema>

export const ModelCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  formats: ModelFormatsSchema,
  inputSize: z.object({ width: z.number(), height: z.number() }),
  /**
   * Channel count of the model input tensor. Omit ⇒ 3 (RGB), the default for
   * every detector / classifier / embedder. Set to 1 for a grayscale CTC text
   * recognizer (EasyOCR VGG plate-OCR: input `[N,1,H,W]`) so the preprocess
   * feeds a single-channel, EasyOCR-normalized tensor instead of the default
   * 3-channel RGB one. Threaded through `PoolModelConfig.inputChannels` to the
   * Python inference pool.
   */
  inputChannels: z.number().int().positive().optional(),
  labels: z.array(LabelDefinitionSchema).readonly(),
  inputLayout: z.enum(['nchw', 'nhwc']).optional(),
  /**
   * `'scrfd'` applies InsightFace's SCRFD input contract, `(x - 127.5) / 128`
   * (upstream `insightface/model_zoo/scrfd.py`), instead of the historical
   * plain `/255`. Measured against COCO GT: 188 → 196 faces found on the
   * `scrfd-2.5g` catalog entry (2026-09-26 model-replacement spike, §2.4-2).
   */
  inputNormalization: z.enum(['zero-one', 'imagenet', 'none', 'scrfd']).optional(),
  /**
   * The model already applies softmax IN-GRAPH — its raw output is a
   * probability distribution, not logits. When set, the `softmax`
   * postprocessor must NOT re-apply softmax: re-softmaxing an already-normalised
   * probability vector collapses it toward uniform (top-1 score craters far
   * below its true value, making every confidence gate meaningless). Absent ⇒
   * the output is raw logits and the postprocessor applies softmax (the normal
   * case). Set on the Google AIY Birds `bird-classifier` (softmax baked into the
   * TF graph). Threaded to the Python pool via `PoolModelConfig.outputProbabilities`.
   */
  outputProbabilities: z.boolean().optional(),
  preprocessMode: z.enum(['letterbox', 'resize']).optional(),
  /**
   * Per-MODEL postprocessor override. Absent ⇒ the step's own
   * `StepDefinition.postprocessor` applies (the normal case — every model in a
   * step shares its decode). Set it when a step hosts models with DIFFERENT raw
   * output layouts under one slot: e.g. object-detection is `'yolo'` by default,
   * but a Coral SSD MobileNet build emits the `TFLite_Detection_PostProcess`
   * 4-tensor layout and needs `'ssd'`. Threaded into `PoolModelConfig.postprocessor`
   * by the engine factory (`modelEntry.postprocessor ?? def.postprocessor`).
   */
  postprocessor: z.custom<PostprocessorType>().optional(),
  /**
   * Per-MODEL default confidence floor. Absent ⇒ the step's
   * `StepDefinition.defaultConfidence` applies. A score is a property of one
   * model's output scale, not of the step slot it sits in: YuNet's
   * `sqrt(cls·obj)` is not SCRFD's score, and inheriting SCRFD's 0.5 filled the
   * face gallery with wheels and hands (D662, amends D645). An operator's
   * explicit value still wins over it. Resolved in ONE place —
   * `addon-pipeline/.../registry/effective-confidence.ts`.
   */
  defaultConfidence: z.number().min(0).max(1).optional(),
  /**
   * Per-MODEL default of the per-class confidence floors (`minConfidence<Macro>`
   * on a detector step), keyed by macro class: `{ person: 0.45 }`. A class
   * absent here runs at the step slider's global default. The same row shape
   * the floor measurement produces (`model-floors.json`: modelId → floors), so
   * a measured table is copied in as-is. An operator override is bound to the
   * model it was made for and does not survive a model change (D738). A custom
   * / imported model may declare it; without it, the global defaults apply.
   */
  defaultClassFloors: z.record(z.string(), z.number().min(0).max(1)).optional(),
  /**
   * The inference precision this model's OpenVINO IR needs on an Intel GPU.
   * Absent ⇒ the device default (f16 on a GPU). Set to `'f32'` for an FP32 IR
   * that produces invalid output at f16 — measured 2026-10-07 for YOLO26
   * base IRs (`yolo26s`: 0 true / 146 false positives; `yolo26m*`: NaN
   * scores) on the Core Ultra iGPU and the N100. Threaded to the pool as
   * `PoolModelConfig.gpuInferencePrecision`; the pool sets
   * INFERENCE_PRECISION_HINT on a GPU only. Costs ~60% latency on the GPU.
   */
  gpuInferencePrecision: z.enum(['f32', 'f16']).optional(),
  /**
   * ROOT detectors only: per supplied step (`animal-classifier`, …), the
   * minimum DETECTION score from which this root's own fine label (species,
   * vehicle type — D736 root supply) is taken (D741). Below it the detection
   * keeps its macro class without the fine label. `1` = never take it from
   * this root. Absent ⇒ no floor beyond the macro floor. The supplied step's
   * `minConfidence` slider, bound to the ROOT model, overrides it.
   */
  suppliedLabelFloors: z.record(z.string(), z.number().min(0).max(1)).optional(),
  /**
   * When true, the executor produces a landmark-aligned crop (similarity warp
   * onto the canonical template) before this step runs, instead of a plain
   * axis-aligned bbox crop. Required for face-recognition embedders (ArcFace):
   * their embeddings are only discriminative on an aligned input. The face
   * detector that produced the parent detail must emit 5 landmarks.
   */
  faceAlignment: z.boolean().optional(),
  /**
   * Auxiliary files required at runtime (labels JSON, charset dict, etc.).
   * Downloaded into the same modelsDir alongside the model file.
   */
  extraFiles: z.array(ModelExtraFileSchema).readonly().optional(),
  /**
   * LEGACY entry — retained in the catalog so a persisted operator selection
   * still RESOLVES (and can be re-activated), but hidden from the selectable
   * model list and excluded from the auto format-default pick. Set on the
   * superseded / consolidated models (older lineages, redundant fp16 IRs) so
   * the active lineup stays the coherent curated ladder without deleting a
   * model anyone may still be pinned to. `resolveModelForFormat` keeps honoring
   * an explicit legacy id that has a build for the node's format.
   */
  legacy: z.boolean().optional(),
  /**
   * Measured quality/latency metadata — populated from the benchmark addon on
   * the real node classes. Absent = not yet measured (most entries today; the
   * catalog historically carried only `sizeMB`, a poor cross-architecture
   * speed proxy). `p95LatencyMs` is keyed by node class (e.g. `n100`, `mac`).
   */
  metrics: z
    .object({
      map50: z.number().optional(),
      p95LatencyMs: z.record(z.string(), z.number()).optional(),
    })
    .optional(),
  /**
   * The model's licence record — see {@link ModelLicenseSchema}. Optional in
   * the schema (a custom model's author may state none); REQUIRED and complete
   * on every built-in catalog entry (`scripts/check-catalog-licence.ts`).
   */
  license: ModelLicenseSchema.optional(),
  /**
   * Variant-selector grouping. The UI groups models by `family` + `tier` and
   * offers `precision` / `optimization` as variant axes WITHIN a tier — so all
   * of a family's sizes and quantizations collapse into one grouped picker
   * instead of a flat list of `yolo26s`, `yolo26s-int8`, … Absent ⇒ ungrouped
   * (legacy / custom models) — never shown in the grouped selector. The flat
   * `id` stays the source of truth for resolution/download/persistence; grouping
   * is a presentation overlay resolved back to an `id`.
   */
  group: ModelVariantGroupSchema.optional(),
  /**
   * Catalog source for the pipeline stepper's provider-first picker. Absent on
   * built-in CamStack entries (treated as `camstack`) and on registry rows
   * persisted before this field existed (`inferModelProvider` fills those).
   */
  provider: ModelProviderIdSchema.optional(),
  /**
   * Per-MODEL class map override. Absent ⇒ the step's `StepDefinition.classMap`
   * applies (plus catalog / COCO public catalog). Set on a custom model whose raw
   * labels already ARE the CamStack macros (plugin catalog identity map).
   */
  classMap: DetectionCatalogClassMapSchema.optional(),
  /**
   * The pipeline steps this ROOT detector can supply from its own output
   * (D730): its labels name a step's effect (`deer` for `animal-classifier`)
   * or draw a step's box (`license_plate` for `plate-detection`). Computed at
   * import from THIS model's labelmap by `deriveRootSupplies`, never written
   * by hand and never assumed per family; a row without it is derived on read
   * (`rootSuppliesOf`). Whether a camera uses it is the step's own
   * `useRootModel` flag (`resolveRootSupply`).
   */
  suppliesSteps: z.array(RootStepSupplySchema).readonly().optional(),
  /**
   * The model's CLIP feature-space contract (text encoder, dimension, vector
   * index, token window, search floor) — see `clip-model.ts`. Present ONLY on a
   * CLIP image encoder; its absence is what "not a CLIP model" means to the
   * embedding encoder and the semantic-search store (D649).
   */
  clip: ClipModelMetaSchema.optional(),
})

export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>

export interface DetectionModel {
  readonly id: string
  readonly name: string
  readonly labels: readonly string[]
  readonly inputSize: { readonly width: number; readonly height: number }
}

export interface ModelDownloadOptions {
  readonly url: string
  readonly fallbackUrls?: readonly string[]
  readonly destDir: string
  readonly filename?: string
  readonly expectedSha256?: string
  readonly onProgress?: (downloaded: number, total: number) => void
}

export interface ModelDownloadResult {
  readonly filePath: string
  readonly downloadedBytes: number
  readonly fromCache: boolean
}

export interface CustomModelMetadata {
  readonly name: string
  readonly inputSize: { readonly width: number; readonly height: number }
  readonly labels: readonly LabelDefinition[]
  readonly classMap?: ClassMapDefinition
  readonly inputLayout?: 'nchw' | 'nhwc'
  readonly inputNormalization?: 'zero-one' | 'imagenet' | 'none' | 'scrfd'
  readonly outputFormat: ModelOutputFormat
}

// --- P3: model conversion ---

export const ConvertTargetSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('openvino'),
    precisions: z
      .array(z.enum(['fp16', 'int8']))
      .min(1)
      .readonly(),
  }),
  z.object({ format: z.literal('coreml') }),
])
export type ConvertTarget = z.infer<typeof ConvertTargetSchema>

export const ModelConvertMetadataSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string(),
  labels: z.array(LabelDefinitionSchema).readonly(),
  inputSize: z.object({ width: z.number(), height: z.number() }),
  inputLayout: z.enum(['nchw', 'nhwc']).optional(),
  inputNormalization: z.enum(['zero-one', 'imagenet', 'none', 'scrfd']).optional(),
  preprocessMode: z.enum(['letterbox', 'resize']).optional(),
  outputFormat: z.enum(['yolo', 'ssd', 'embedding', 'classification', 'ocr', 'segmentation']),
  faceAlignment: z.boolean().optional(),
  classMap: DetectionCatalogClassMapSchema.optional(),
})
export type ModelConvertMetadata = z.infer<typeof ModelConvertMetadataSchema>

export const ConvertArtifactSchema = z.object({
  format: z.enum(MODEL_FORMATS),
  precision: z.enum(['fp16', 'int8']).optional(),
  sizeMB: z.number(),
  validated: z.boolean(),
  files: z.array(z.string()).readonly(),
})
export type ConvertArtifact = z.infer<typeof ConvertArtifactSchema>

export const ConvertResultSchema = z.object({
  entry: ModelCatalogEntrySchema,
  artifacts: z.array(ConvertArtifactSchema).readonly(),
})
export type ConvertResult = z.infer<typeof ConvertResultSchema>
