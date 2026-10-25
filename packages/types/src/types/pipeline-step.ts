import type { ConfigField } from '../interfaces/config-ui.js'
import type { StepModelScope } from '../pipeline/cluster-model-scope.js'
import type { ClassMapDefinition } from './labels.js'
import type { ModelCatalogEntry } from './models.js'
import type { PipelineSlot } from './pipeline.js'
import type { SuppliedRootOutput } from '../capabilities/pipeline-executor.cap.js'

// ---------------------------------------------------------------------------
// IPipelineStep — class contract for pipeline steps (future addon extraction)
// ---------------------------------------------------------------------------

/**
 * Each pipeline step implements this interface as a class.
 * `definition` holds the static metadata; `getConfigSchema()` declares
 * per-step settings (class filters, thresholds, etc.) that the UI renders
 * dynamically and that can be overridden per-run.
 */
export interface IPipelineStep {
  readonly definition: StepDefinition
  /**
   * `model` — the catalog entry the step runs, when the caller knows it. A
   * threshold slider's `default` is the MODEL's floor when it declares one
   * (`ModelCatalogEntry.defaultConfidence`, D662); absent ⇒ the step's.
   */
  getConfigSchema(model?: ModelCatalogEntry): readonly ConfigField[]
}

// ---------------------------------------------------------------------------
// Postprocessor types — declares how to interpret raw model output
// ---------------------------------------------------------------------------

export type PostprocessorType =
  | 'yolo'
  | 'ssd'
  // DETR-style query decode (300 queries, cxcywh normalised + per-query logits;
  // class column 1 — column 0 is the no-object slot). Per-MODEL override on the
  // `rfdetr-package` parcel detector; see `python/postprocessors/rfdetr.py`.
  | 'rfdetr'
  // flat-NMS YOLO-NAS flat batched-NMS ONNX export: ONE [N,7] output of
  // (batch_idx, x1, y1, x2, y2, score, class_id) rows in input pixel space,
  // post-NMS. Per-MODEL override used by plus catalog/plus catalog `yolonas` models
  // imported via Model Studio; see `python/postprocessors/yolonas.py`.
  // COMPILE-TIME ONLY member: the zod side is `z.custom<PostprocessorType>()`
  // (no runtime enum), so addons compiled against this union run correctly on
  // hubs whose installed framework predates it.
  | 'yolonas'
  | 'yolo-seg'
  | 'scrfd'
  // YuNet (OpenCV Zoo) face decode: ONE anchor-free prior per cell, centre +
  // exp(size) boxes, score sqrt(cls·obj) over `cls_*`/`obj_*`, 5 landmarks in
  // SCRFD's order. Per-MODEL override on `yunet-2023mar` (the face-detection
  // step default stays `scrfd`); see `python/postprocessors/yunet.py`.
  // COMPILE-TIME ONLY, like `yolonas`: nothing validates it at runtime.
  | 'yunet'
  // plugin catalog YOLOv9 TFLite / EdgeTPU: 6-tensor DFL split-head
  // (3 strides × box[N,64] + cls[N,C]), not the ONNX [1,7,2100] pack. Per-MODEL
  // override stamped on plugin catalog tflite imports; see
  // `python/postprocessors/yolo_split_dfl.py`.
  | 'yolo-split-dfl'
  | 'arcface'
  | 'clip'
  | 'softmax'
  | 'ctc'
  // Fixed-slot plate recognition (`max_plate_slots` independent softmax heads
  // over a 37-glyph plate alphabet, no CTC blank). Per-MODEL override on
  // `cct-s-v2-global`; see `python/postprocessors/plate_slots.py`. It gates on a
  // per-character confidence floor rather than text length — a slot reader is
  // never silent on its own.
  | 'plate-slots'
  | 'saliency'
  | 'yamnet'

// ---------------------------------------------------------------------------
// Step definition — replaces per-addon class, one record per pipeline step
// ---------------------------------------------------------------------------

export interface StepDefinition {
  /** Unique step identifier (e.g., 'object-detection', 'face-detection') */
  readonly id: string
  /** Human-readable name */
  readonly name: string
  /** Pipeline slot type */
  readonly slot: PipelineSlot
  /** Which postprocessor to apply to raw model output */
  readonly postprocessor: PostprocessorType
  /**
   * How this step receives its input:
   * - `full-frame` — the whole frame (root detectors like object-detection).
   * - `crop-roi` — a crop of a PARENT detection's bbox (child steps like
   *   face-detection, plate-detection, classifiers).
   * - `crop-zone` — a crop of the device's own `package`-stage zone-rules
   *   polygons (+ upscale for small-parcel recall), NOT a parent detection.
   *   A ROOT-plane detector (`inputClasses === null`) that makes the drawn
   *   package zones its inference input instead of the full frame. Used by the
   *   `package-detection` step (design ADDENDUM). NOTE: the frame-preparation
   *   for `crop-zone` (zone-bbox crop + upscale + bbox re-projection back to
   *   full-frame coords) is a pipeline-runner concern that is NOT yet
   *   implemented — a `crop-zone` root currently runs full-frame until that
   *   plumbing lands (see step-definitions.ts STEP_PACKAGE_DETECTION).
   */
  readonly extractMode: 'full-frame' | 'crop-roi' | 'crop-zone'
  /** Classes this step accepts from a parent detector (null = root, accepts full frame) */
  readonly inputClasses: readonly string[] | null
  /** Classes this step outputs (e.g., ['person','vehicle','animal'] for YOLO) */
  readonly outputClasses: readonly string[]
  /**
   * WHICH label tier this step's answer occupies on a track / ObjectEvent
   * (roadmap 4g). **Declared here and nowhere else** — a consumer never infers
   * a tier from `outputClasses`, from the step id, or from the shape of the
   * text. A step that produces a label and declares no tier has its answer
   * REFUSED and logged, because a guess here is exactly how a species ends up
   * in the coarse slot and blocks the sub-class that should have gone there.
   *
   *  - `1` — a SUB-CLASS, finer than the macro class but still a taxonomy
   *    token: `animal-classifier` (`animal-type`), `vehicle-classifier`
   *    (`vehicle-type`), and `object-detection` itself (its raw class, when
   *    finer than the macro it maps to — `dog` under `animal`).
   *  - `2` — an INSTANCE, the finest thing sayable about this subject:
   *    `bird-classifier` (`species`), `face-embedding` (`identity`),
   *    `plate-ocr` (`plate-text`).
   *
   * Absent on a step that produces no label at all (a detector whose classes
   * ARE macro classes, an embedder, a segmenter). Absence is not tier 0 — it
   * means "this step never fills a label slot".
   */
  readonly labelTier?: 1 | 2
  /** Available models for this step */
  readonly models: readonly ModelCatalogEntry[]
  /** Default model when no user preference is set */
  readonly defaultModelId: string
  /**
   * Optional per-format model preference. When an agent seeds its
   * `addonDefaults[this.id]`, it looks up `defaultModelIdByFormat[agent.activeEngine.format]`
   * first, then falls back to `defaultModelId`. Lets a step express "on
   * coreml prefer apple-soundanalysis, on onnx prefer yamnet-onnx" without
   * duplicating the step definition per engine.
   */
  readonly defaultModelIdByFormat?: Readonly<Record<string, string>>
  /**
   * WHOSE choice this step's model is — see
   * [`pipeline/cluster-model-scope.ts`](../pipeline/cluster-model-scope.ts).
   *
   *  - `'node'` (the default when absent) — per (node, device). Two nodes may
   *    answer differently because nothing compares their outputs: a box is a
   *    box.
   *  - `'cluster'` — ONE value for the whole cluster, stored in ONE
   *    `pipeline-orchestrator` global row. Declared by a step that writes into a
   *    SHARED VECTOR INDEX (`face-embedding` → the enrolled gallery,
   *    `clip-embedding` → `vec_object_clip`), where a second model does not
   *    degrade the ranking, it makes it meaningless — and nothing inside a
   *    vector can reveal which encoder produced it.
   *
   * A `'cluster'` declaration changes the RESOLUTION RULE, not just the storage:
   * a node whose format ships no build of the chosen model REFUSES the step and
   * logs it, where a node-scoped step would substitute that format's default
   * ([D54](../../../../docs/decisions/adr-0056.md)). Substituting is what fills
   * one index from several encoders.
   */
  readonly modelScope?: StepModelScope
  /**
   * Whether a newly-seeded agent has this addon enabled by default.
   * Absent = `true`. Operators can always toggle this after boot; this
   * flag only controls the initial seed for operator-first-touch
   * convenience (e.g. keep refiners off by default so operators opt in
   * rather than out).
   */
  readonly enabledByDefault?: boolean
  /** Default confidence threshold */
  readonly defaultConfidence: number
  /** Runtime label lookup (e.g., class name arrays for softmax, charset for CTC) */
  readonly labels?: readonly string[]
  /**
   * Classifier output classes that must NEVER be emitted — a hard reject list
   * applied to the top-1 winner AND the alternates after classification.
   * Used for a "background"/"none" catch-all class a classifier emits when the
   * crop is not a member of any real class (e.g. the Google AIY bird model's
   * index-964 `background`): without this the classifier would surface
   * `background` as a species label on cats/people/foliage. Compared
   * case-insensitively against the predicted class name. Absent ⇒ no rejection.
   */
  readonly rejectClasses?: readonly string[]
  /** Character set for CTC decode (index 0 = blank token) */
  readonly charset?: readonly string[]
  /**
   * Region plate grammar for format-aware plate-OCR rescoring (CTC steps).
   * ISO-3166 alpha-2 code (`'DE'`, future `'IT'`/`'FR'`) selecting the grammar
   * the greedy read is validated against; `'off'` disables rescoring. Forwarded
   * to the Python CTC postprocessor exactly like {@link charset}. Absent ⇒ the
   * postprocessor's backward-compatible 'off' fallback (no rescoring).
   */
  readonly plateRegion?: string
  /**
   * Minimum non-space character count below which a CTC read is suppressed as
   * degenerate near-all-blank noise (plate-OCR plausibility gate). Forwarded to
   * the Python postprocessor; absent ⇒ its `DEFAULT_MIN_TEXT_LENGTH` (3).
   */
  readonly minTextLength?: number
  /**
   * Confidence floor below which a CTC read is suppressed (plate-OCR
   * plausibility gate). Forwarded to the Python postprocessor; absent ⇒ its
   * `DEFAULT_MIN_TEXT_CONFIDENCE` (0, disabled).
   */
  readonly minTextConfidence?: number
  /**
   * Plausibility gate for a FIXED-SLOT plate reader (`plate-slots`): the
   * minimum probability the WEAKEST emitted character must carry. It replaces
   * {@link minTextLength}, which carries no information for a reader that emits
   * a full-length string on every input including a blank wall. Forwarded to
   * the Python postprocessor; absent ⇒ its `DEFAULT_MIN_CHAR_PROBABILITY`.
   */
  readonly minCharProbability?: number
  /** COCO-to-macro class mapping (e.g., 'car' → 'vehicle') */
  readonly classMap?: ClassMapDefinition
  /** UI grouping label — steps with the same group are displayed together (e.g., 'Segmentation') */
  readonly group?: string
  /**
   * Default minimum parent detection score to trigger this child step.
   * Child steps are skipped if the parent detection's confidence is
   * below this threshold. Saves inference for low-confidence detections.
   * E.g., face-detection with minParentScore=0.7 only runs on persons
   * detected with score ≥ 0.7. Configurable per-step via settings.
   */
  readonly defaultMinParentScore?: number
  /**
   * Detail-subtree dispatch cadence — how often a track-level consumer
   * should invoke `pipelineRunner.runDetailSubtree` for this step. Only
   * meaningful for child steps (`inputClasses !== null`); root steps
   * (object-detection, audio-classifier) run on every frame instead and
   * ignore this field. Absent on a child step falls back to the catalog
   * builder's default (`{ trigger: 'once', maxPerTrack: 3 }` — see
   * `PipelineStepBase` in `addon-pipeline`'s step-definitions.ts).
   */
  readonly cadence?: StepCadence
}

/**
 * Scheduling policy for a detail-subtree step, shared by
 * `StepDefinition.cadence` (the catalog authority) and
 * `DetailStepAnnounce.cadence` (the per-camera announce derived from it —
 * see `interfaces/event-bus.ts`).
 */
export interface StepCadence {
  readonly trigger: 'once' | 'improve' | 'periodic'
  readonly minIntervalMs?: number
  readonly maxPerTrack?: number
  readonly stickyOnConfidence?: number
}

// ---------------------------------------------------------------------------
// Pool model config — passed to Python inference_pool.py per model
// ---------------------------------------------------------------------------

export interface PoolModelConfig {
  /** Absolute path to the model file (.mlpackage, .xml, .onnx) */
  readonly path: string
  /**
   * Largest dimension of model input (e.g., 640 for 640×640). Retained for
   * backward compatibility and as the fallback when the explicit
   * `inputWidth`/`inputHeight` are absent (square models).
   */
  readonly inputSize: number
  /**
   * Explicit input WIDTH in px. Present for every model; equals `inputSize`
   * for square inputs. Non-square recognizers (plate-OCR VGG `384×64`) rely on
   * this so the Python preprocess resizes to the real aspect instead of
   * squaring the crop.
   */
  readonly inputWidth?: number
  /** Explicit input HEIGHT in px (see {@link inputWidth}). */
  readonly inputHeight?: number
  /**
   * Channel count of the model input tensor. Omit ⇒ 3 (RGB). `1` selects the
   * grayscale CTC recognizer path (EasyOCR-normalized `[N,1,H,W]`).
   */
  readonly inputChannels?: number
  /** How to preprocess the image before inference */
  readonly preprocessMode: 'letterbox' | 'resize'
  /**
   * Input pixel normalization. Absent / `'zero-one'` / `'none'` ⇒ the default
   * `/255` rescale only (byte-identical to the historical unconditional path,
   * used by every detector + CLIP/ArcFace + the AIY bird classifier which bakes
   * its own scale). `'imagenet'` ⇒ additionally subtract the ImageNet
   * mean/std per channel — required by the EfficientNet/MobileNetV3 animal +
   * vehicle classifiers (their `labels.json` declares `normalize: imagenet`).
   * `'scrfd'` ⇒ InsightFace's SCRFD input contract, `(x - 127.5) / 128`
   * (upstream `insightface/model_zoo/scrfd.py`) — required by the
   * `scrfd-2.5g` catalog entry (2026-09-26 model-replacement spike, §2.4-2).
   * Threaded from `ModelCatalogEntry.inputNormalization`.
   */
  readonly inputNormalization?: 'zero-one' | 'imagenet' | 'none' | 'scrfd'
  /**
   * The model's output is ALREADY a softmax probability distribution (softmax
   * baked into the graph). When true the `softmax` postprocessor skips its own
   * softmax pass and consumes the raw output as probabilities. See
   * `ModelCatalogEntry.outputProbabilities`.
   */
  readonly outputProbabilities?: boolean
  /**
   * OpenVINO GPU inference precision the model needs (`INFERENCE_PRECISION_HINT`,
   * GPU only). See `ModelCatalogEntry.gpuInferencePrecision`. Absent ⇒ device default.
   */
  readonly gpuInferencePrecision?: 'f32' | 'f16'
  /** Postprocessor to apply to raw output in Python */
  readonly postprocessor: PostprocessorType
  /** Confidence threshold for NMS / filtering */
  readonly confidence: number
  /** IoU threshold for the detector's non-max suppression (dedup). Read by the
   *  Python postprocessors (yolo / yolo-seg / scrfd); when absent they fall back
   *  to their 0.45 literal, so an unset value is byte-identical to today. */
  readonly nmsIouThreshold?: number
  /** Label names for softmax-based classifiers */
  readonly labels?: readonly string[]
  /** Character set for CTC-based recognizers */
  readonly charset?: readonly string[]
  /**
   * Region plate grammar for format-aware CTC plate-OCR rescoring (ISO-3166
   * alpha-2, e.g. `'DE'`; `'off'` disables). Read by the Python CTC
   * postprocessor. See {@link StepDefinition.plateRegion}.
   */
  readonly plateRegion?: string
  /** Plate-OCR plausibility gate: minimum non-space character count. */
  readonly minTextLength?: number
  /** Plate-OCR plausibility gate: confidence floor. */
  readonly minTextConfidence?: number
  /**
   * Fixed-slot plate-OCR gate: minimum per-character probability. See
   * {@link StepDefinition.minCharProbability}.
   */
  readonly minCharProbability?: number
  /** Number of classes (for YOLO: 80 COCO or 1 for plate) */
  readonly numClasses?: number
  /** Anchor strides for SCRFD (default [8, 16, 32]) */
  readonly strides?: readonly number[]
  /** Mask threshold for saliency/segmentation */
  readonly maskThreshold?: number
  /** Hardware device target (CoreML: cpu/gpu/ane/all, OpenVINO: auto/cpu/gpu/npu, ONNX: cpu/cuda/coreml) */
  readonly device?: string
}

// ---------------------------------------------------------------------------
// Step output — discriminated union (replaces duck typing)
// ---------------------------------------------------------------------------

export interface DetectionsOutput {
  readonly kind: 'detections'
  readonly detections: readonly {
    readonly class: string
    readonly score: number
    readonly bbox: readonly [number, number, number, number]
    readonly landmarks?: readonly { readonly x: number; readonly y: number }[]
    /** Base64-encoded binary mask cropped to bbox (instance segmentation) */
    readonly mask?: string
    /** Width of the decoded mask in pixels */
    readonly maskWidth?: number
    /** Height of the decoded mask in pixels */
    readonly maskHeight?: number
  }[]
}

export interface ClassificationsOutput {
  readonly kind: 'classifications'
  readonly classifications: readonly {
    readonly class: string
    readonly score: number
  }[]
  /** Full ranked list for debugging (top-N). Only populated when traceVerbosity is enabled. */
  readonly alternates?: readonly {
    readonly class: string
    readonly score: number
  }[]
}

export interface EmbeddingOutput {
  readonly kind: 'embedding'
  readonly embedding: readonly number[]
  readonly embeddingNorm: readonly number[]
}

export interface TextOutput {
  readonly kind: 'text'
  readonly text: string
  readonly confidence: number
  /**
   * Format-aware plate-OCR annotation (CTC steps with an active
   * `plateRegion`). `true` when the returned `text` matches the region plate
   * grammar (either the greedy read already conformed, or confusable rescoring
   * repaired it to a conforming candidate); `false` when no grammar-conforming
   * read was found and the original greedy read was kept verbatim. Absent when
   * rescoring is disabled (`plateRegion: 'off'` / unset) or the read was
   * suppressed by the plausibility gate.
   */
  readonly formatValid?: boolean
}

export interface MaskOutput {
  readonly kind: 'mask'
  readonly mask: string
  readonly maskWidth: number
  readonly maskHeight: number
  /** Largest-connected-component bbox in mask-pixel space [x, y, w, h]. */
  readonly maskBbox?: readonly [number, number, number, number]
}

/** Discriminated union for step output — use switch(output.kind) */
export type StepOutput =
  | DetectionsOutput
  | ClassificationsOutput
  | EmbeddingOutput
  | TextOutput
  | MaskOutput

// ---------------------------------------------------------------------------
// Execution trace — unified observability for live, benchmark, and test
// ---------------------------------------------------------------------------

export type TraceVerbosity = 'off' | 'summary' | 'full'

/**
 * Execution plane for a pipeline run (two-plane design). `'full'` (default)
 * runs the whole tree — benchmark, reference-image, and detail-subtree
 * calls. `'frame'` is the live per-frame dispatch: ONLY root-plane steps
 * (`StepDefinition.inputClasses === null`) run; crop children are skipped
 * and served per-track via a separate detail-subtree call instead.
 */
export type PipelineExecutionPlane = 'full' | 'frame'

/**
 * Why a frame is being run. `'replay'` is a session replay (D646): the camera's
 * own tree over STORED pixels. Its log lines say so, and its drop sampling is
 * kept apart from the live camera's — a replay must never use up the live
 * first-example budget or read as a live line. Absent = `'live'`.
 */
export type PipelineRunOccasion = 'live' | 'replay'

export interface PipelineRunOptions {
  readonly traceVerbosity?: TraceVerbosity
  readonly plane?: PipelineExecutionPlane
  readonly occasion?: PipelineRunOccasion
  /**
   * Root-supplied output for a crop-kind root step (D730,
   * `pipelineExecutor.runPipeline.suppliedRoot`): that step is not inferred.
   */
  readonly suppliedRoot?: SuppliedRootOutput
}

export interface StepTrace {
  readonly stepId: string
  readonly modelId: string
  readonly slot: PipelineSlot
  readonly postprocessor: PostprocessorType

  // Timing
  readonly preprocessMs: number
  readonly inferenceMs: number
  readonly postprocessMs: number
  readonly totalMs: number

  // Input
  readonly inputType: 'full-frame' | 'crop-roi'
  readonly inputSize: { readonly width: number; readonly height: number }
  /** Class name of the parent detection that triggered this step */
  readonly parentDetection?: string

  // Output
  readonly outputKind: StepOutput['kind']
  readonly outputCount: number
  /** Human-readable top result (e.g., "person 0.92", "cat 0.88", "ABC123") */
  readonly topResult?: string

  // Error (if step failed)
  readonly error?: string
}

export interface PipelineExecutionTrace {
  readonly traceId: string
  readonly deviceId: number
  readonly timestamp: number
  readonly frameSize: { readonly width: number; readonly height: number }
  readonly engineRuntime: string
  readonly steps: readonly StepTrace[]
  readonly totalMs: number
  readonly detectionCount: number
  // Index signature keeps this type assignable to `SystemEvent.data`
  // (Record<string, unknown>) so it can be used directly as the typed
  // payload for the `pipeline.trace` event category. Mirrors the pattern
  // used by MotionAnalysisPayload, MotionZonesRawPayload, etc.
  readonly [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Motion raw event — always emitted, before detection filtering
// ---------------------------------------------------------------------------

export interface MotionBox {
  readonly bbox: readonly [number, number, number, number]
  readonly changeScore: number
}

export interface MotionRawEvent {
  readonly type: 'motion.raw'
  readonly deviceId: string
  readonly timestamp: number
  readonly boxes: readonly MotionBox[]
  readonly frameSize: { readonly width: number; readonly height: number }
  readonly motionScore: number
}

export interface PipelineTraceEvent {
  readonly type: 'pipeline.trace'
  readonly trace: PipelineExecutionTrace
}
