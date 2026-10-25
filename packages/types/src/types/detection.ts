import type { FirstLevelMacroClass } from './labels.js'
import type { AudioClassifyOutcome } from '../capabilities/schemas/detection-shared.js'
import type { TrackState } from '../capabilities/pipeline-analytics.cap.js'
import type { AppearanceDescriptor } from './appearance.js'
import type { BoundingBox as EngineBoundingBox, FrameInput, Landmark } from './io.js'

// ---------------------------------------------------------------------------
// Engine-level types (produced by Python/ONNX runtime, consumed by the
// pipeline executor internally before the result assembler)
// ---------------------------------------------------------------------------

export interface SpatialDetection {
  readonly class: string
  readonly originalClass: string
  readonly score: number
  readonly bbox: EngineBoundingBox
  readonly landmarks?: readonly Landmark[]
  readonly mask?: Uint8Array
  readonly maskWidth?: number
  readonly maskHeight?: number
  /**
   * Mirrored from {@link ObjectDetection.nativeRecovery} when this detection
   * enters the tracker. The tracker's SPAWN gates (per-class score floor,
   * person-over-animal dedup) are tuned for the coarse full-frame pass; a box
   * measured at native resolution is not the thing they exist to kill.
   */
  readonly nativeRecovery?: NativeRecoveryEvidence
  /**
   * Mirrored from {@link ObjectDetection.birthEvidence} when this detection
   * enters the tracker, so a birth the tracker mints carries the pixels that
   * produced it all the way to the confirmation gate (D379).
   */
  readonly birthEvidence?: BirthEvidence
  /**
   * Mirrored from {@link ObjectDetection.appearance} when this detection enters
   * the tracker (D683). Absent = no descriptor was computed (too small, no
   * raster, a runner that predates it): never read as "different".
   */
  readonly appearance?: AppearanceDescriptor
}

export interface CropInput {
  readonly frame: FrameInput
  readonly roi: EngineBoundingBox
  readonly parentDetection: SpatialDetection
}

export interface Classification {
  readonly class: string
  readonly score: number
  readonly text?: string
  readonly embedding?: Float32Array
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface DetectorOutput {
  readonly detections: readonly SpatialDetection[]
  readonly inferenceMs: number
  readonly modelId: string
}

export interface CropperOutput {
  readonly crops: readonly SpatialDetection[]
  readonly inferenceMs: number
  readonly modelId: string
}

export interface ClassifierOutput {
  readonly classifications: readonly Classification[]
  readonly inferenceMs: number
  readonly modelId: string
}

export interface RefinerOutput {
  /** Base64-encoded binary mask for the refined detection region */
  readonly mask: string
  readonly maskWidth: number
  readonly maskHeight: number
  readonly inferenceMs: number
  readonly modelId: string
}

// ---------------------------------------------------------------------------
// Frame-result types — the canonical output shape consumed by every
// downstream surface (benchmark UI, live view, analysis pipeline,
// notifications, event bus). Replaces the legacy PipelineRunResult /
// PipelineDetection / LabelData chain.
// ---------------------------------------------------------------------------
//
// Design:
//   - `FrameResult`  is the per-frame container for VIDEO detections
//   - `AudioResult`  is the per-window container for AUDIO detections
//   - Every entry in `detections[]` is a `Detection` — either an
//     `ObjectDetection` (first-level or detail) or an `AudioDetection`
//   - Details (face, plate) live at the ROOT of `detections[]`, not nested;
//     they carry `parentId` pointing back to the first-level that
//     produced them (person → face, vehicle → plate)
//   - First-level detections INHERIT labels from their details
//     (e.g. a person carries the face's recognized name) — each inherited
//     label keeps its original score and carries `detectionId = <detail id>`
//     so callers can jump back to the source detail
//   - `Detection.labels` is `readonly ScoredLabel[]` — each enrichment
//     records both its text + confidence
//   - Debug info (step latencies, model ids, top-N candidates, masks) lives
//     under `detection.debug` and is opt-in (populated only when detection
//     debug mode is on). Frame-level debug (aggregate step timings,
//     engine descriptor) lives under `FrameResult.debug`.

/** Axis-aligned bounding box in absolute pixel coordinates of the source frame. */
export interface DetectionBoundingBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * A single enriched label attached to a detection.
 *
 * - In `Detection.labels[]` it represents an enrichment that "won" on this
 *   detection (either produced directly on it, or inherited from a child
 *   detail in the same frame).
 * - In `DetectionDebug.alternateLabels[source][]` it represents one
 *   candidate from a top-N ranked list.
 */
export interface ScoredLabel {
  readonly label: string
  readonly score: number
  /**
   * When this label was inherited from a child detail (e.g. a person
   * carrying a recognized face name), this is the child detection's id.
   * Omitted on own enrichments — the label already lives on the entry
   * that carries it.
   */
  readonly detectionId?: string
  /**
   * WHICH label slot this text may occupy on a track / ObjectEvent, copied
   * VERBATIM from the producing step's `StepDefinition.labelTier` (roadmap
   * 4g). 1 = sub-class (`dog`), 2 = instance (`Turdus migratorius`, `Alice`,
   * a plate read).
   *
   * Absent means the producing step declares no tier — an internal marker
   * (`embedding:512d`), or a step that was never given a declaration. The
   * persistence write rule REFUSES an undeclared label rather than inferring
   * a tier from the text or the step name, and says so in the log. Inheriting
   * a label onto a parent copies the tier unchanged: the tier belongs to the
   * step that decided the text, not to the entry that carries it.
   */
  readonly tier?: 1 | 2
  /** Step that decided this text — the tier's attribution. */
  readonly stepId?: string
  /** Model that decided this text — the tier's attribution. */
  readonly modelId?: string
}

/** What kind of entry a detection is at the root of `detections[]`. */
export type DetectionKind = 'first-level' | 'detail' | 'audio'

/**
 * First-level macro classes produced by object detectors.
 *
 * Alias of {@link FirstLevelMacroClass} — THE list lives in `labels.ts`
 * (`FIRST_LEVEL_MACRO_CLASSES`), which is also the offer of the
 * `object-detection` step and the domain of `RecordingTriggers.objectClasses`. Do not
 * rewrite the union here: there were two hand-kept copies, and that is how a macro
 * added in one place only goes unnoticed.
 */
export type FirstLevelMacro = FirstLevelMacroClass

/** Detail macro classes produced by crop+recognize steps. */
export type DetailMacro = 'face' | 'plate'

/**
 * Macro class carried at the root of each Detection entry. Kept as an
 * extensible string union so future detectors (e.g. a custom
 * `first-level-fire` classifier) can plug in without a type change.
 */
export type MacroClass = FirstLevelMacro | DetailMacro | 'audio' | string

/** Tracker-enriched info attached to first-level detections only. */
export interface TrackInfo {
  readonly trackId: string
  /**
   * What the tracker says this subject is DOING, as of this frame.
   *
   * Computed for every track on every frame by `StateAnalyzer` (10 s to
   * `stationary`) and carried here so a consumer can draw a parked car
   * differently from one that is moving — which is the whole reason the
   * verdict is computed.
   *
   * It replaces an unused `moving?: boolean` (and a `speedPx?: number`) that
   * sat here declared and NEVER assigned anywhere in the repo, while the live
   * overlay drew a person standing still exactly like one walking. A boolean
   * would also have been lossy: `stationary` and `loitering` are different
   * things to show.
   *
   * ABSENT means the tracker has not classified this track yet — not "moving".
   * A fresh track must not flash as stationary for its first frames.
   *
   * The CANONICAL `TrackState`, the same enum tracks and events already carry
   * (`idle` is the still one — `stationary` and `loitering` both map into it).
   * Deliberately not `ObjectState`, the analyzer's internal spelling: one fact
   * with two vocabularies on the wire is how two readers start disagreeing.
   */
  readonly movementState?: TrackState
  /** IDs of zones the bbox overlaps at this frame. */
  readonly zones?: readonly string[]
  /** Wall-clock timestamp (ms) when the track was first seen. */
  readonly firstSeenMs?: number
  /** Wall-clock timestamp (ms) of the last update on this track. */
  readonly lastSeenMs?: number
}

/** Per-detection debug bag — populated only when detection debug is enabled. */
export interface DetectionDebug {
  /** Latency of each step that touched this detection (source → ms). */
  readonly stepLatencyMs?: Readonly<Record<string, number>>
  /** Model id used by each step that touched this detection (source → modelId). */
  readonly modelIds?: Readonly<Record<string, string>>
  /** How the step read the image — full frame or cropped ROI. */
  readonly extractMode?: 'full-frame' | 'crop-roi'
  /**
   * Raw detector class before any macro mapping. Present only when it
   * differs from `macroClass` (e.g. object-detection returned `'dog'`,
   * mapped to `macroClass: 'animal'`).
   */
  readonly originalClass?: string
  /**
   * The label tier {@link originalClass} may occupy, from the ROOT detector
   * step's `StepDefinition.labelTier` (roadmap 4g). Ships in the same
   * `verbosity: 'full'` bag as the value it qualifies, so it costs nothing
   * where `originalClass` costs nothing.
   *
   * Without it the raw class is a label with no declared tier and the write
   * rule refuses it — which is the correct outcome, because outside
   * `verbosity: 'full'` the FrameProcessor substitutes `det.macroClass` for a
   * missing `originalClass` and a tier guessed here would put a MACRO class in
   * a label slot. That is the exact regression the 2026-08-07 rule refuses.
   */
  readonly originalClassTier?: 1 | 2
  /**
   * Full top-N ranked alternatives per source (classifier / recognizer).
   * The winner of each list already appears in `detection.labels[]` —
   * this field surfaces the rest for the benchmark UI and debug inspectors.
   */
  readonly alternateLabels?: Readonly<Record<string, readonly ScoredLabel[]>>
  /** Base64 binary segmentation mask (when a seg/refiner step produced one). */
  readonly mask?: string
  readonly maskWidth?: number
  readonly maskHeight?: number
  /** Id of the embedding stored by face/voice/plate recognition, when any. */
  readonly embeddingId?: string
}

/** Per-step timing in a frame-level debug bag. Aggregate across all the detections. */
export interface FrameStepTiming {
  /** Step addon id. */
  readonly source: string
  /** Model id used during this frame. */
  readonly modelId?: string
  /** Total wall-clock latency contributed by this step to the frame. */
  readonly ms: number
  /** How many detections this step contributed (for per-step throughput). */
  readonly detectionCount?: number
}

/** Per-frame debug bag — populated only when detection debug is enabled. */
export interface FrameDebug {
  /** Sum of all step latencies for this frame (not wall-clock). */
  readonly totalInferenceMs?: number
  /** Flat list of per-step timings. */
  readonly stepTimings?: readonly FrameStepTiming[]
  /** Engine descriptor — e.g. `'python/coreml'`. */
  readonly engine?: string
  /** Pipeline id in use (for comparing across runs). */
  readonly pipelineId?: string
  /** JPEG → dimensions probe + buffer alloc (benchmark / reference-image paths only). */
  readonly decodeMs?: number
  /** Per-run setup: step conversion, engine factory init, model load, tree build. */
  readonly setupMs?: number
  /** Total wall-clock of runPipeline from entry to return — includes decode, setup, inference, progress emit. */
  readonly wallMs?: number
  /** Residual = wallMs - (decodeMs + setupMs + totalInferenceMs). Surfaces tRPC / IPC / overhead. */
  readonly overheadMs?: number
  /** Python-pool preprocess wall (PIL resize + tensor pack). Excludes IPC + window-accumulator wait. */
  readonly preprocessMs?: number
  /** Python-pool predict wall (model.predict only). Pure ANE/CoreML/ORT execute time. */
  readonly predictMs?: number
  /** Window-accumulator batch size used for the predict call (1 = no batching, N = N frames coalesced). */
  readonly batchSize?: number
}

/** Common shape shared by every entry in `FrameResult.detections` / `AudioResult.detections`. */
export interface DetectionBase {
  readonly id: string
  readonly kind: DetectionKind
  readonly macroClass: MacroClass
  /** Score of the macro class itself (from the detector that emitted this entry). */
  readonly score: number
  /**
   * Enrichment labels — each with its own score. Ordered:
   * (1) chain of direct enrichers on the detection,
   * (2) labels inherited from the children details (in order of appearance).
   * The score preserves the value produced by the original enricher even
   * when the label is inherited.
   */
  readonly labels: readonly ScoredLabel[]
  readonly track?: TrackInfo
  readonly debug?: DetectionDebug
  /**
   * Present when this box did NOT come from the full-frame pass but from a
   * SECOND detector pass on a native-resolution crop of a motion region
   * (`small-subject-recovery.ts` in the runner). See
   * {@link NativeRecoveryEvidence}.
   */
  readonly nativeRecovery?: NativeRecoveryEvidence
  /**
   * The box's own pixels, cut by the runner at the instant of detection, for a
   * box it had not seen recently. See {@link BirthEvidence} — this is what the
   * confirmation gate looks at instead of asking for pixels afterwards.
   */
  readonly birthEvidence?: BirthEvidence
}

/**
 * What a native-resolution second pass ALREADY measured about a box.
 *
 * The first-level detector sees a 4K frame at 320 px: a 100 px dog is 8 px and
 * is not emitted. The runner's recovery pass re-runs THE SAME detector on a
 * 640–800 px native square around the moving region and finds it at 0.82–0.91
 * (`docs/benchmarks/pipeline-frame-model-eval.md`, case `miss-dog-101`). That
 * pass is already a second look at better pixels — so every downstream gate
 * whose job is to ask "did the coarse pass see a real thing?" has its answer,
 * and re-deriving a THIRD, tighter crop of the same subject can only lose
 * information (D377).
 *
 * Carried from the runner to post-analysis on the emitted frame result and
 * mirrored onto the tracker's {@link SpatialDetection}. Plain data: no pixels,
 * no handle — the crop it names is long gone, and its VERDICT is what travels.
 */
export interface NativeRecoveryEvidence {
  /** Score the second pass measured, on the native crop, with the same model. */
  readonly score: number
  /** Side of the native square the crop was cut from, in native pixels. */
  readonly cropSidePx: number
  /** Side of the compressed view the model actually saw, in pixels. */
  readonly viewPx: number
}

/**
 * The pixels of a candidate birth, CUT AT THE INSTANT IT WAS DETECTED.
 *
 * ## Why this exists (D379)
 *
 * The confirmation gate asks one question of a new track: re-run the detector
 * on a crop of the box and see whether the subject is really there. Until now
 * it asked for those pixels AFTERWARDS, by `FrameHandle`, across a process
 * boundary — and measured on the live hub over three hours that request fails
 * 7 452 times, 99.9% of them `worker-lease-gone`, at a median handle age of
 * 1 347 ms and misses recorded as early as 254 ms. The frame is not evicted
 * late; it is very often never retained at all (`leaseAdmitted:9` against
 * `leaseMarks:297` on one measured worker, `leaseReleasedEarly:288`). 1 191 of
 * 1 883 gate verdicts in that window (63%) never saw a pixel.
 *
 * So the crop is cut where the pixels are already in hand — in the runner, on
 * the frame the detection was measured on — and RIDES the detection. No store,
 * no handle, no lease, no round trip, and above all no OTHER INSTANT: a subject
 * that has moved is not in a later frame, and its absence there is not evidence
 * it was never here.
 *
 * The discipline is structural: a decoded frame is invalidated the moment the
 * `for await` body returns, so every second look — face crop, embedding,
 * retained detection image — is taken IN BAND.
 *
 * ## What it is NOT
 *
 * Not a detail/CLIP crop, and nothing here calls `deriveDetailCropRect` (D52):
 * this rectangle is the detection box padded for a CLASSIFICATION question and
 * is never fed to an embedder, never stored as media, never indexed. It is also
 * not a frame: it is one small JPEG of one box, cut only for a box the runner
 * has not seen recently, so it never crosses a boundary at frame rate (D9/D18).
 */
export interface BirthEvidence {
  /** Base64 JPEG of {@link rect}, cut from the frame this detection was measured on. */
  readonly jpegBase64: string
  /**
   * The rectangle the JPEG covers, in ABSOLUTE pixels of the analysis frame —
   * the same space as `DetectionBoundingBox`. The gate needs it to put a
   * crop-space re-detection back into the frame (secondary promotion), and it
   * is the padded box, never the bare one.
   */
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  /**
   * Which raster it was cut from. `analysis` is the ≤640 detection frame the
   * runner holds in its own address space — the only raster that is present,
   * for free, at the instant of detection. A future native rung would add a
   * value here rather than change the meaning of this one.
   */
  readonly tier: 'analysis'
}

/** Object detection (first-level person/vehicle/animal OR detail face/plate). */
export interface ObjectDetection extends DetectionBase {
  readonly kind: 'first-level' | 'detail'
  /** Absolute pixel coordinates in the source frame. */
  readonly bbox: DetectionBoundingBox
  /** Tight footprint box from a Segmentation step (largest mask component), absolute px. */
  readonly refinedBbox?: DetectionBoundingBox
  /** Base64 binary segmentation mask (promoted from debug when a Segmentation step ran). */
  readonly mask?: string
  readonly maskWidth?: number
  readonly maskHeight?: number
  /**
   * For details (face, plate): id of the first-level parent entry in
   * the same frame. Allows the UI to correlate a face crop back to the
   * person box (or a plate back to the vehicle box).
   */
  readonly parentId?: string
  /**
   * A `detail` the ROOT model drew (D730): a plus catalog `license_plate` / `face`
   * box contained in its parent, standing in for the named crop step's
   * inference. Never a track (D683) — only `first-level` entries are.
   */
  readonly rootSupplied?: { readonly stepId: string; readonly modelId: string }
  /**
   * Normalized (L2, ||v||=1) face/biometric embedding produced by an
   * in-pipeline embedding step (arcface, `inputClasses:['face']`). Present on
   * the `face` detail that arcface ran on, and inherited onto its parent
   * person detection (same per-`parentId` inheritance as labels). Absent when
   * no embedding step ran or the runner predates this field. Length is the
   * model's dimension (512 for arcface-r100) — derive `dim` from `.length`.
   */
  readonly embedding?: readonly number[]
  /** Model id that produced `embedding` (e.g. `arcface-r100`). Present iff
   *  `embedding` is present — lets consumers skip samples from a stale model. */
  readonly embeddingModelId?: string
  /**
   * L2 magnitude of the RAW (pre-normalization) embedding — i.e. `‖v‖` of the
   * vector `embedding` is the unit form of. Present iff `embedding` is.
   *
   * It is here because it is a free quality signal that used to be destroyed:
   * the arcface postprocessor returns the raw vector and its normalized form,
   * and the assembler kept only the normalized one. For this model a usable
   * face sits at ‖v‖ ≈ 4.4 whatever its size, grey level or blur, while an
   * information-free crop jumps to 10–16 — and a degenerate crop scores HIGH
   * cosine against everything, so it can only be caught before matching, never
   * by a threshold. See `pipeline/embedding-magnitude-gate.ts` in
   * addon-post-analysis for the measurement and the gate.
   */
  readonly embeddingMagnitude?: number
  /**
   * The EXACT landmark-aligned crop (base64-encoded JPEG) that a face-embedding
   * step fed to the recognizer for THIS `face` detail — i.e. the literal ArcFace
   * model input the `embedding` above was computed from. Present iff an aligned
   * crop was produced (a `faceAlignment` model ran with ≥5 landmarks); absent on
   * the plain-crop fallback and on non-face detections. Lets a gallery display
   * the true embedded crop (1:1 with the embedding, for match debugging) instead
   * of a separately captured natural crop. Small (a 112² JPEG), cheap to carry on
   * the face detail. Only the `face` detail carries it — it is NOT inherited onto
   * the parent person (the person box is not the ArcFace input).
   */
  readonly faceAlignedCrop?: string
  /**
   * Short side (px) of the face measured on the NATIVE surface the aligned
   * crop was cut from — the executor's own native-aware size measure
   * (`aligned.nativeFaceShortSidePx`). The detail's `bbox` travels in the
   * DOWNSCALED detection-frame space (≈640-wide), where a face that is
   * 90–200px at native reads as 15–33px — so any consumer gating on
   * `min(bbox.w, bbox.h)` against a pixel threshold silently discards every
   * distant-camera face (2026-07-22: zero faces from the 4K outdoor cameras).
   * Consumers MUST prefer this measure when present and fall back to the
   * detection-space bbox only when absent (older runners / no native surface).
   * Present iff the face path cut its aligned crop from a native surface.
   */
  readonly nativeFaceShortSidePx?: number
  /**
   * The five facial landmarks the face detector regressed for THIS `face`
   * detail, in the same absolute pixel space as `bbox` (D644). Only a face
   * detail carries them; never inherited onto the parent.
   */
  readonly landmarks?: readonly { readonly x: number; readonly y: number }[]
  /**
   * The box's model-free appearance descriptor, computed by the runner on the
   * frame this detection was measured on (D683). First-level boxes only.
   */
  readonly appearance?: AppearanceDescriptor
}

/** Audio detection — flat, time-localised within the window. */
export interface AudioDetection extends DetectionBase {
  readonly kind: 'audio'
  readonly startMs: number
  readonly endMs: number
}

/**
 * Union of every possible detection entry at the root of a result payload.
 *
 * Named `DetectionEntry` rather than `Detection` because the
 * device-capabilities namespace already exports a different `Detection`
 * interface for object detectors. The two live in separate files but
 * both are re-exported at the package root, so keeping names distinct
 * avoids an import-level collision.
 */
export type DetectionEntry = ObjectDetection | AudioDetection

/**
 * Why a POST-NMS box was dropped between the model and the overlay. One code
 * per drop site — the diagnostic overlay shows the code verbatim, so a new
 * drop site MUST add its own code here rather than reuse a neighbour's:
 *  - `class-filter`: class not in the step's `enabledMacroClasses`, or a
 *    COCO class the `classMap` does not map (both are class-identity drops
 *    and both count toward the trace's model-saw/kept gap).
 *  - `below-threshold`: score under the per-macro `minConfidence<Macro>`.
 *  - `full-frame-guard`: the full-frame phantom guard
 *    (`pipeline/full-frame-guard.ts`).
 *  - `zone-gate`: dropped by a detection-stage zone rule AFTER the frame
 *    result was built (`gateDetectionsByZoneRules`).
 *
 * NMS suppression is NOT a reason here: every engine's NMS runs in-process in
 * the Python pool (`inference_pool.py` postprocessors) and the suppressed set
 * is destroyed before the boundary — the trace's model-saw count is the only
 * NMS visibility. A reason that can never fire does not belong in the union.
 */
export type DiscardReason = 'class-filter' | 'below-threshold' | 'full-frame-guard' | 'zone-gate'

/**
 * A post-NMS box the pipeline dropped before it could reach the overlay /
 * tracker / events — always carried on `FrameResult.discarded` when a frame
 * drops at least one box (the discarded set is post-NMS and
 * post-confidence-floor: a handful of boxes per frame, not the raw
 * candidate flood, which never leaves the Python pool).
 *
 * `bbox` is the executor's `[x1, y1, x2, y2]` tuple in ABSOLUTE
 * analysis-frame pixels (the same space the executor's drop sites hold) —
 * consumers normalise against `FrameResult.width`/`height` from the same
 * frame. Deliberately NOT the survivors' `{x, y, width, height}` object:
 * the tuple is what every drop site already holds, and the viewer's
 * `parseDiscardedEvent` accepts it as-is.
 */
export interface DiscardedDetection {
  /** `[x1, y1, x2, y2]` in absolute analysis-frame pixels. */
  readonly bbox: readonly [number, number, number, number]
  /** Macro class where the classMap resolves one, else the raw model class. */
  readonly macroClass: string
  readonly score: number
  readonly reason: DiscardReason
}

/**
 * Per-frame pipeline result — the canonical container emitted by
 * `pipelineExecutor.runPipeline` (one-shot benchmark + runtime dispatch)
 * and by the live video pipeline. Carries only `ObjectDetection` entries
 * (video has no audio events).
 */
export interface FrameResult {
  readonly kind: 'frame'
  readonly frameId: string
  readonly deviceId: number
  /** Wall-clock timestamp (ms) of frame capture / emission. */
  readonly timestamp: number
  readonly width: number
  readonly height: number
  readonly detections: readonly ObjectDetection[]
  /**
   * Post-NMS boxes the pipeline dropped on this frame (see
   * {@link DiscardedDetection}). Always populated when at least one box was
   * dropped — absent means "nothing dropped", never "empty array". A frame
   * that drops nothing allocates nothing and puts no field on the wire.
   */
  readonly discarded?: readonly DiscardedDetection[]
  /**
   * Overload-shed marker: the inference pool DELIBERATELY skipped a ROOT
   * step of this frame (`EngineOutput.dropped` — flow control, never an
   * error), so no root inference ran and `detections` is empty by
   * construction. First-class so consumers that count drops (the capacity
   * ramp's drop accounting, timing samplers) can distinguish "shed under
   * load" from "genuinely no detections" without guessing from an empty
   * array. Same absence rule as `discarded`: absent when every root step
   * actually ran, never `false` on the wire.
   */
  readonly shed?: true
  /** Which bound shed the frame (e.g. `'worker-in-flight-cap'`). Present iff `shed` is. */
  readonly shedReason?: string
  /**
   * The model the ROOT detector ACTUALLY ran for this frame — after the
   * executor's format resolution, so a substituted model is named as what
   * ran, not as what was asked (`object-detection` when it runs, else the
   * first enabled root). Stamped by `pipelineExecutor.runPipeline`; absent on
   * a frame no pipeline root produced (a camera's onboard detector). A stored
   * track keeps it so a later replay can name the original model (D646).
   */
  readonly rootModelId?: string
  /**
   * The step (addon id) of the root {@link rootModelId} names — the detector
   * whose boxes this frame's tracks are born from. Stamped beside it, same
   * absence rule. With {@link rootModelId} and {@link rootDeviceKey} it is the
   * session's detector, which the birth confirmation gate re-judges a birth
   * with (D925).
   */
  readonly rootStepId?: string
  /**
   * The inference DEVICE the root ran on (`openvino:npu`, `edgetpu:pci`,
   * `onnx:webgpu` …) — the pool the dispatch actually used, after re-election
   * and the capability fallback, stamped beside {@link rootModelId}. A session
   * can hop node or device between on-motion sessions (D916), so a stored
   * track keeps the device of the frame that opened it and of the sighting
   * that closed it (D924); the confirmation gate re-judges a birth on this
   * pool (D925). Absent on a frame no pipeline root produced, and from a
   * runner older than the field.
   */
  readonly rootDeviceKey?: string
  /**
   * The `package-detection` root RAN on this frame and was not shed — the
   * motion-settle governor dispatched it. The only way a consumer can tell
   * "the step looked at the doormat and found nothing" from "nobody looked":
   * both arrive as a frame with no package box. Same absence rule as `shed`:
   * absent when the step did not run, never `false` on the wire; a runner
   * older than the field never attests an absence (D687).
   */
  readonly packageLooked?: true
  readonly debug?: FrameDebug
}

/**
 * Per-audio-window pipeline result — the canonical container emitted by
 * the audio pipeline. Carries only `AudioDetection` entries plus optional
 * window-level level metrics.
 */
export interface AudioResult {
  readonly kind: 'audio-window'
  readonly windowId: string
  readonly deviceId: number
  /** Wall-clock timestamp (ms) of the window start. */
  readonly timestamp: number
  /** Offset (ms) of the window start inside the source audio stream. */
  readonly startMs: number
  /** Offset (ms) of the window end inside the source audio stream. */
  readonly endMs: number
  /** Aggregate audio level metrics (RMS / dBFS), independent from detections. */
  readonly level?: {
    readonly rms: number
    readonly dbfs: number
  }
  readonly detections: readonly AudioDetection[]
  /**
   * Whether the classifier RAN on this window (D660). Empty `detections` with
   * `classified` = heard nothing above the floor; `not-classified` = the
   * window reached no model (superseded by the camera's newer window, a
   * failed inference, shutdown). Optional ONLY for frames emitted before
   * D660, where absence means unknown — every current producer sets it.
   */
  readonly classifyOutcome?: AudioClassifyOutcome
  readonly debug?: FrameDebug
}

/** Discriminated union of every top-level pipeline result payload shape. */
export type PipelineFrameResult = FrameResult | AudioResult
