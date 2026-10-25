/**
 * PipelineExecutor — recursive tree execution on a single frame.
 *
 * Walks the ExecutableTree, runs each step against the engine, and feeds
 * the outputs into the `ResultAssembler` which produces the canonical
 * `FrameResult` shape consumed by every downstream surface.
 *
 * Responsibilities:
 *   1. Run root steps on the full frame
 *   2. For each detection, match children by classFilter
 *   3. Crop the ROI and run the child step
 *   4. Recurse into grandchildren
 *   5. Hand outputs to `applyChildOutput`, which routes them into the
 *      current detection's labels / alternateLabels / mask fields, OR
 *      spawns new detail entries (face / plate) when the child is a
 *      cropper.
 *   6. Call `buildFrameResult` at the end to produce the final
 *      immutable `FrameResult` with flattened first-level + detail
 *      entries.
 */
import type {
  DetectionsOutput,
  DiscardedDetection,
  FrameResult,
  FrameViewGeometry,
  FrameStepTiming,
  InferenceInput,
  IScopedLogger,
  LogTags,
  PipelineExecutionPlane,
  PipelineExecutionTrace,
  PipelineRunOptions,
  StepOutput,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import { dispatchPostprocess } from '../postprocess/dispatch.js'
import {
  type AbsoluteBbox,
  cropJpeg,
  isBboxDegenerate,
  transformBboxToImageSpace,
} from './crop-utils.js'
import { DROP_SUMMARY_INTERVAL_MS, DropSampler } from './drop-sampler.js'
import { ExecutionTraceBuilder } from './execution-trace.js'
import { bboxShortSide, buildAlignedFaceCrop, type NativeFaceCropProvider } from './face-align.js'
import {
  DEFAULT_LANDMARK_PRECISION_FLOOR_PX,
  landmarkPrecisionVerdict,
} from './landmark-precision-gate.js'
import { isFullFramePhantomDetection, isFullFrameSurvivor } from './full-frame-guard.js'
import { NATIVE_CHILD_CROP_MAX_WIDTH, nativeChildCrop } from './native-child-crop.js'
import { resolveEffectivePostprocessor } from '../registry/effective-postprocessor.js'
import { rectifyPlateJpeg } from './plate-deskew.js'
import {
  expandBbox,
  plateOcrMarginFraction,
  resolvePlateOcrCropPolicy,
} from './plate-ocr-crop-policy.js'
import {
  attachRootChildBoxes,
  cropSupplyForLabel,
  type RootChildCandidate,
} from './root-child-boxes.js'
import { warpPlateJpeg } from './plate-warp.js'
import {
  type AssemblyContext,
  applyChildOutput,
  buildFrameResult,
  FrameIdGenerator,
  type MutableObjectDetection,
  toMutableRootDetection,
} from './result-assembler.js'
import type { ExecutableStep, ExecutableTree } from './tree-builder.js'
import { macroGateVerdict } from './macro-gate.js'
import { linkedLabelsFor } from './linked-label.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Default minimum short-side (px, source-frame resolution) of a face bbox for
 * which a recognition embedding is attempted. Faces smaller than this upscale
 * into weaker embeddings; we skip them rather than pollute clustering. Override
 * per-step via `settings.minFaceSize`.
 *
 * Lowered 40 → 28 (2026-07-14): detection runs on a downscaled frame (e.g.
 * 640×360), so an indoor person's face is often 28-38px there and was being
 * skipped entirely — no faces collected. 28px still warps acceptably onto the
 * 112×112 ArcFace input; the honest below-threshold count is surfaced by the
 * throttled "too small to embed" diagnostic (with the actual `faceShortSidePx`).
 * The quality-preserving alternative is to run face-detection at a higher input
 * resolution — a deeper change tracked separately.
 */
const DEFAULT_MIN_FACE_SIZE_PX = 28

/**
 * Cheap pre-native floor (px, detection space): below this a face is treated as
 * genuinely degenerate — SCRFD landmarks are unreliable and even a large native
 * upscale can't rescue it — so it is skipped WITHOUT paying a native-crop
 * round-trip. Above the floor, the real {@link DEFAULT_MIN_FACE_SIZE_PX} gate is
 * evaluated on the NATIVE face size (see the face branch of `executeChildren`).
 */
const MIN_FACE_DETECTION_FLOOR_PX = 6

/**
 * Cap (px) on the width of the NATIVE face crop fetched for embedding (design
 * B). The arcface input is a fixed 112² warp, so a wider native crop buys no
 * embedding quality past a modest margin but does inflate the per-face transport
 * of the best-effort native-crop round-trip. 320px keeps a distant face well
 * above the downscaled detection resolution while bounding the crop payload.
 */
const NATIVE_FACE_CROP_MAX_WIDTH = 320

/**
 * StepOutput kinds that synthesize a full-frame detection when they run at
 * the tree ROOT (see `synthesizeRootDetection`) — classifier/embedding/OCR
 * steps promoted to root by `pipelineRunner.runDetailSubtree` (task 6b), e.g.
 * `clip-embedding`, `animal-classifier`, `plate-ocr`. Detector (`'detections'`)
 * roots take the normal path. `'text'` is included so a `plate-ocr` step run
 * standalone on an already-cut plate crop (parent class `plate`) synthesizes a
 * full-frame detection carrying the recognized text as a label, instead of
 * silently dropping — the OCR chain otherwise only surfaces text when nested
 * under `plate-detection`. `'mask'` roots remain out of scope.
 */
type EnrichmentOutput = Extract<StepOutput, { kind: 'classifications' | 'embedding' | 'text' }>

function isEnrichmentOutput(output: StepOutput): output is EnrichmentOutput {
  return output.kind === 'classifications' || output.kind === 'embedding' || output.kind === 'text'
}

/**
 * Read a numeric step setting, falling back to `fallback` when the key is
 * absent or not a finite number. A type guard rather than a cast — a step's
 * `settings` bag is `Record<string, unknown>` because it is operator data, and
 * asserting `as number` over it is how a string from a form becomes a silent
 * NaN comparison that admits everything.
 */
function numericSetting(
  settings: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: number,
): number {
  const raw = settings?.[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/**
 * Stamp the camera onto an inference input so a failure inside the SHARED pool
 * can name it (`InferenceInput.deviceId` — diagnostic only, it selects
 * nothing). Immutable, and a no-op for a caller with no real camera: the
 * benchmark and the reference runs pass `deviceId: 0`, and a fabricated `0` in
 * a log tag is worse than no tag.
 */
function withInferenceDeviceId(input: InferenceInput, deviceId: number): InferenceInput {
  if (!Number.isFinite(deviceId) || deviceId <= 0) return input
  if (input.deviceId === deviceId) return input
  return { ...input, deviceId }
}

/**
 * Re-project a `crop-zone` root's detections from crop-relative coordinates
 * back to full-frame image space by the crop's origin — the root analogue of
 * the crop-roi child re-projection (`transformBboxToImageSpace`). Landmarks (if
 * any) are shifted by the same origin. Immutable: returns a fresh output.
 */
function reprojectCropZoneDetections(
  output: DetectionsOutput,
  cropOrigin: AbsoluteBbox,
): DetectionsOutput {
  const [ox, oy] = cropOrigin
  return {
    kind: 'detections',
    detections: output.detections.map((det) => ({
      ...det,
      bbox: transformBboxToImageSpace(det.bbox, cropOrigin),
      ...(det.landmarks
        ? {
            landmarks: det.landmarks.map((l) => ({ x: l.x + ox, y: l.y + oy })),
          }
        : {}),
    })),
  }
}

function reprojectViewDetections(
  output: DetectionsOutput,
  geometry: FrameViewGeometry,
): DetectionsOutput {
  const mapPoint = (x: number, y: number): { x: number; y: number } => ({
    x: geometry.sourceCrop.left + x / geometry.scale.x,
    y: geometry.sourceCrop.top + y / geometry.scale.y,
  })
  return {
    kind: 'detections',
    detections: output.detections.map((det) => {
      const origin = mapPoint(det.bbox[0], det.bbox[1])
      const end = mapPoint(det.bbox[2], det.bbox[3])
      return {
        ...det,
        bbox: [origin.x, origin.y, end.x, end.y] as const,
        ...(det.landmarks
          ? {
              // Landmarks share bbox's view-space contract: content-sized
              // output pixels, not source/native. mapPoint inverts the view.
              landmarks: det.landmarks.map((landmark) => mapPoint(landmark.x, landmark.y)),
            }
          : {}),
      }
    }),
  }
}

export interface RootInputView {
  readonly input: InferenceInput
  readonly jpegProvider: () => Promise<Buffer>
  readonly width: number
  readonly height: number
  readonly geometry: FrameViewGeometry
}

export type RootInputViewProvider = (
  root: ExecutableStep,
  crop?: AbsoluteBbox,
) => Promise<RootInputView>

export interface PipelineExecutorOptions {
  /** Engine runtime string for trace metadata (e.g. `"python+coreml"`). */
  readonly engineRuntime: string
  /**
   * Optional logger — used to surface child-step failures. When unset,
   * child failures are swallowed to keep parent detections in the result
   * (legacy behaviour); when set, each failure is logged at warn so the
   * pipeline isn't silently degraded.
   */
  readonly logger?: IScopedLogger
}

/**
 * Accumulator for python-pool per-stage wall timings — populated as each
 * `executeStep` reads the engine output. Surfaces preprocess vs predict
 * split, plus the actual batch size used by the window accumulator.
 */
interface PoolStageAccumulator {
  preprocessMs: number
  predictMs: number
  batchSize: number
}

/**
 * Per-frame ROOT-shed accumulator. Filled by `executeStep` when the pool
 * sheds a root step under overload; `run()` turns a non-zero count into the
 * frame-level `FrameResult.shed` marker. Deliberately mutable — it is a
 * per-run accumulator with the same lifetime and pattern as
 * `PoolStageAccumulator` above, never escaping `run()`.
 */
interface RootShedAccumulator {
  count: number
  reasons: string[]
}

// ---------------------------------------------------------------------------
// PipelineExecutor
// ---------------------------------------------------------------------------

export class PipelineExecutor {
  /** Bounds the full-frame-guard drop log: first example per (device,
   *  class), then a counted summary per minute. See `drop-sampler.ts`. */
  private readonly dropSampler = new DropSampler()

  /** Bounds the classifier class-filter drop log the same way, keyed per
   *  (device, `step:class`) — an excluded species firing on every frame of a
   *  track must be a line and a counter, not wallpaper. */
  private readonly classFilterDropSampler = new DropSampler()

  constructor(private readonly opts: PipelineExecutorOptions) {}

  /** Per-key last-warn timestamps, so a persistently-failing/skipping child
   *  step surfaces a diagnostic without spamming the log every frame. */
  private readonly warnThrottleAt = new Map<string, number>()

  private throttledWarn(
    key: string,
    everyMs: number,
    message: string,
    meta: Readonly<Record<string, unknown>>,
    deviceId?: number,
  ): void {
    const logger = this.opts.logger
    if (!logger) return
    const now = Date.now()
    const last = this.warnThrottleAt.get(key) ?? 0
    if (now - last < everyMs) return
    this.warnThrottleAt.set(key, now)
    // Device-related diagnostics MUST carry the deviceId tag so they land in
    // the camera's own log stream (operator rule) — an engine failure that only
    // shows in the pool's worker-scoped log is invisible when debugging a camera.
    if (deviceId !== undefined) {
      logger.warn(message, { tags: { deviceId }, meta })
      return
    }
    // IScopedLogger renders structured fields under `meta` — a flat second arg
    // is dropped, which is why the earlier diagnostic logged the message but not
    // the sizes. Wrap so `faceShortSidePx`/`minFaceSizePx`/`error` show up.
    logger.warn(message, { meta })
  }

  /**
   * Surface WHY a face embedding was skipped — a detected face simply too small
   * (distance / night) is the common silent cause of "faces stopped collecting".
   * Reports the detection-space short side AND, when the skip was decided on the
   * native crop, the NATIVE face size so an operator sees the size that actually
   * gated. Throttled so it isn't per-frame spam.
   */
  private warnFaceTooSmall(
    child: ExecutableStep,
    detShortSidePx: number,
    minFaceSizePx: number,
    nativeFaceShortSidePx: number | undefined,
    deviceId: number,
    diag?: Record<string, number>,
  ): void {
    this.throttledWarn(
      `face-small:${child.stepId}:${deviceId}`,
      30_000,
      'face detected but too small to embed — skipping',
      {
        step: child.stepId,
        model: child.modelId,
        faceShortSidePx: Math.round(detShortSidePx),
        minFaceSizePx,
        gatedOn: nativeFaceShortSidePx === undefined ? 'detection' : 'native',
        ...(nativeFaceShortSidePx === undefined
          ? {}
          : { nativeFaceShortSidePx: Math.round(nativeFaceShortSidePx) }),
        ...diag,
      },
      deviceId,
    )
  }

  /**
   * Execute the full pipeline tree against a frame.
   *
   * `rootInput` carries the frame in its source representation
   * (jpeg | raw). The root step receives this as-is. Child steps that
   * crop a parent detection always need a JPEG buffer (cropJpeg is
   * JPEG-only); when the root frame is raw, `fullFrameJpegProvider`
   * is called lazily on the first crop and its result is cached. Trees
   * without crop children pay zero JPEG encode cost on the raw fast
   * path.
   *
   * @returns FrameResult + optional trace
   */
  async run(
    tree: ExecutableTree,
    rootInput: InferenceInput,
    fullFrameJpegProvider: () => Promise<Buffer>,
    imageWidth: number,
    imageHeight: number,
    deviceId: number,
    runOpts?: PipelineRunOptions,
    /**
     * Best-effort NATIVE-resolution ROI crop provider bound to THIS frame
     * (design B, generalized). When present:
     *  - face-embedding children align on the native face crop, and
     *  - LEAF non-face crop children (`plate-ocr`, leaf classifiers) read a
     *    native cut of their ROI instead of the downscaled parent tile,
     * — the quality win (native pixels for the model input). On the detail
     * plane the provider re-composes the executor's crop-normalized ROI into
     * frame space (see `native-crop-compose`), so the SAME provider serves both
     * the full-frame and per-crop cases. A miss (or absence, e.g. benchmark /
     * non-session-decode) falls back to the downscaled crop — never worse, never
     * an upscale.
     */
    nativeCropProvider?: NativeFaceCropProvider,
    /**
     * Absolute-pixel crop bbox for `crop-zone` root steps (`package-detection`)
     * — the UNION of the device's enabled `package`-stage zones, resolved by
     * the caller (`resolvePackageCropBbox`). When present, a `crop-zone` root
     * runs inference on this crop and its detections are re-projected back to
     * full-frame coords. Absent (benchmark / no zones) ⇒ the root runs
     * full-frame, unchanged.
     */
    cropZoneBbox?: AbsoluteBbox,
    rootInputViewProvider?: RootInputViewProvider,
  ): Promise<{ result: FrameResult; trace: PipelineExecutionTrace | null }> {
    const startMs = Date.now()
    const verbosity = runOpts?.traceVerbosity ?? 'off'
    // A session replay (D646) runs under the camera's deviceId: its lines say
    // `occasion: 'replay'` and its drops sample on their own channel, so it can
    // neither use up the live first-example budget nor read as a live line.
    const occasion = runOpts?.occasion ?? 'live'
    const logTags: LogTags = occasion === 'replay' ? { deviceId, occasion } : { deviceId }

    const traceBuilder = new ExecutionTraceBuilder(
      verbosity,
      deviceId,
      imageWidth,
      imageHeight,
      this.opts.engineRuntime,
    )

    const firstLevel: MutableObjectDetection[] = []
    const details: MutableObjectDetection[] = []
    const stepTimings: FrameStepTiming[] = []
    // Aggregator for python-pool stage timings — preprocess + predict split.
    // Surfaced via FrameDebug.preprocessMs/predictMs/batchSize for benchmark UI.
    const poolAgg: PoolStageAccumulator = {
      preprocessMs: 0,
      predictMs: 0,
      batchSize: 1,
    }
    const debug = verbosity === 'full'

    const idGen = new FrameIdGenerator()
    const ctx: AssemblyContext = {
      idGen,
      details,
      // A confident classifier winner removed by the operator's class filter
      // is dropped WORK: the detection stays on its macro class and, without a
      // line here, "excluded by the allow-list" is indistinguishable from
      // "the classifier never fired" (2026-08-21 sheep incident). Sampled per
      // (device, step:class) — first example in full, then a per-minute count.
      onClassifierClassDropped: (drop) => {
        const sample = this.classFilterDropSampler.record(
          deviceId,
          `${drop.stepId}:${drop.droppedClass}`,
          occasion,
        )
        if (sample.logExample) {
          this.opts.logger?.info('classifier winner excluded by class filter — label dropped', {
            tags: logTags,
            meta: {
              step: drop.stepId,
              model: drop.modelId,
              droppedClass: drop.droppedClass,
              score: Number(drop.score.toFixed(3)),
              reason: drop.reason,
              hint: 'detection keeps its macro class; adjust the step enabledClasses to change this',
            },
          })
        }
        if (sample.summaryCount !== null) {
          this.opts.logger?.info('classifier class filter: still dropping', {
            tags: logTags,
            meta: {
              step: drop.stepId,
              droppedClass: drop.droppedClass,
              suppressed: sample.summaryCount,
              windowMs: DROP_SUMMARY_INTERVAL_MS,
            },
          })
        }
      },
    }

    // Discard trail: every POST-NMS box a drop site removes on this frame is
    // recorded here with its reason, unconditionally, so the viewer's
    // ghost-box overlay has data and not just counts. The set is post-NMS and
    // post-confidence-floor — a handful of boxes per frame, never the raw
    // candidate flood (that stays inside the Python pool). Lazy — stays
    // `undefined` (zero allocation, no field on the result) when nothing was
    // dropped.
    let discarded: DiscardedDetection[] | undefined

    // Shed accounting for ROOT steps: when the pool sheds a root under
    // overload the frame carries a first-class `shed` marker so consumers
    // never have to infer "shed vs genuinely empty" from a zero-length
    // detections array. Passed only to root `executeStep` calls — a shed
    // CHILD is bounded per-track enrichment loss, not a skipped frame.
    const rootShed: RootShedAccumulator = { count: 0, reasons: [] }

    // Execute each root step
    for (const rootStep of tree.roots) {
      // Phase 7 (settings redesign): video pipeline has `object-detection`
      // as its only root. No generic score filter is applied at root —
      // `macroFilterVerdict` below reads the per-macro thresholds from
      // `rootStep.settings` (`minConfidencePerson/Vehicle/Animal`) and
      // enforces them per-detection. Any future root step that also
      // needs a threshold declares its own `minConfidence` field in
      // `getConfigSchema()` and adds an equivalent filter at this site.
      if (debug)
        console.log(
          `[executor] rootStep=${rootStep.stepId} settings=${JSON.stringify(rootStep.settings ?? {})}`,
        )

      // crop-zone extractMode (`package-detection`): a ROOT detector whose
      // input is the device's package zones, not the full frame. Crop the
      // frame to the zone-union bbox and run inference there; the detections
      // are re-projected back to full-frame coords below. A missing/degenerate
      // crop (no zones, benchmark, encode failure) falls back to full-frame —
      // mirrors the crop-roi child path (cropJpeg + transformBboxToImageSpace).
      const rootCrop = rootStep.definition.extractMode === 'crop-zone' ? cropZoneBbox : undefined
      const rootView = rootInputViewProvider
        ? await rootInputViewProvider(rootStep, rootCrop)
        : null
      const cropPrep =
        !rootView && rootCrop !== undefined
          ? await this.prepareCropZoneInput(
              rootCrop,
              fullFrameJpegProvider,
              imageWidth,
              imageHeight,
              deviceId,
            )
          : null

      const rootStart = Date.now()
      // D730: the camera's root model already drew this step's boxes (a
      // plus catalog `license_plate` for `plate-detection`, on the detail plane).
      // The step is not inferred; the supplied boxes ARE its output.
      const supplied =
        runOpts?.suppliedRoot?.stepId === rootStep.stepId ? runOpts.suppliedRoot : undefined
      const rawRootOutput: StepOutput | null = supplied
        ? {
            kind: 'detections',
            detections: supplied.detections.map((d) => ({
              class: rootStep.definition.outputClasses[0] ?? rootStep.stepId,
              score: d.score,
              bbox: d.bbox,
              ...(d.landmarks !== undefined ? { landmarks: d.landmarks } : {}),
            })),
          }
        : await this.executeStep(
            rootStep,
            rootView?.input ?? cropPrep?.input ?? withInferenceDeviceId(rootInput, deviceId),
            rootView?.width ?? cropPrep?.width ?? imageWidth,
            rootView?.height ?? cropPrep?.height ?? imageHeight,
            'full-frame',
            undefined, // no parent bbox
            undefined, // no parent class
            traceBuilder,
            stepTimings,
            poolAgg,
            rootShed,
          )
      const rootMs = Date.now() - rootStart

      // Shed under overload — the frame was deliberately skipped by the pool.
      // Nothing to postprocess, no detections, next root step. The shed
      // itself was recorded into `rootShed` by executeStep and surfaces as
      // the frame-level `shed` marker below.
      if (rawRootOutput === null) continue

      const rootOutput = supplied
        ? rawRootOutput
        : rootView && rawRootOutput.kind === 'detections'
          ? reprojectViewDetections(rawRootOutput, rootView.geometry)
          : cropPrep && rawRootOutput.kind === 'detections'
            ? reprojectCropZoneDetections(rawRootOutput, cropPrep.origin)
            : rawRootOutput

      if (rootOutput.kind !== 'detections') {
        // Non-detector root (task 6b): `runDetailSubtree` promotes a
        // subtree's first step — e.g. `clip-embedding`, `animal-classifier`
        // — to a ROOT so it can run against a single tracked crop via this
        // same executor. Without this branch the output was silently
        // dropped. Synthesize a full-frame detection and attach the
        // classification/embedding to it via the SAME `applyChildOutput`
        // used for a normal child, so the result is indistinguishable from
        // the step running as a child of object-detection.
        if (isEnrichmentOutput(rootOutput)) {
          const mutable = this.synthesizeRootDetection(
            rootOutput,
            rootStep,
            idGen,
            rootMs,
            imageWidth,
            imageHeight,
          )
          applyChildOutput(mutable, rootStep, rootOutput, rootMs, ctx)

          try {
            await this.executeChildren(
              rootStep.children,
              mutable,
              rootView?.jpegProvider ?? fullFrameJpegProvider,
              imageWidth,
              imageHeight,
              traceBuilder,
              stepTimings,
              ctx,
              poolAgg,
              runOpts?.plane,
              deviceId,
              nativeCropProvider,
            )
          } catch (err) {
            this.opts.logger?.warn('Pipeline child execution failed — keeping parent detection', {
              tags: logTags,
              meta: {
                rootStepId: rootStep.stepId,
                parentClass: mutable.macroClass,
                parentScore: mutable.score,
                error: errMsg(err),
              },
            })
          }

          firstLevel.push(mutable)
        }
        continue
      }

      // Root CHILD boxes (D730): a `license_plate` / `face` the root declares
      // as a crop supply is held aside here, then attached to the first-level
      // detection that contains it once this root's detections are final. It
      // never becomes a first-level detection itself — never a track (D683).
      const rootChildCandidates: RootChildCandidate[] = []
      const firstLevelStart = firstLevel.length

      // Process each root detection through children
      for (const det of rootOutput.detections) {
        const cropSupply = cropSupplyForLabel(rootStep.rootSupplies, det.class)
        if (cropSupply !== undefined) {
          rootChildCandidates.push({
            rawClass: det.class,
            score: det.score,
            bbox: [det.bbox[0], det.bbox[1], det.bbox[2], det.bbox[3]],
            supply: cropSupply,
          })
          continue
        }
        // Phase 7: no generic score filter here. `macroFilterVerdict`
        // below applies the per-macro thresholds from settings for
        // object-detection. Other root steps would do their own filter
        // in a similar way — but today object-detection is the only
        // video root.

        const seeded = toMutableRootDetection(det, rootStep, idGen, rootMs)
        const mutable = supplied
          ? {
              ...seeded,
              rootSupplied: { stepId: rootStep.stepId, modelId: supplied.modelId },
              modelIds: { [rootStep.stepId]: supplied.modelId },
            }
          : seeded

        // Apply classMap for child routing (always) and for the macroClass
        // carried at root. The new model drops the macro-vs-COCO split;
        // macro is the only display mode.
        if (rootStep.effectiveClassMap) {
          const mapped = rootStep.effectiveClassMap.mapping[det.class]
          if (mapped) {
            mutable.originalClass = det.class
            mutable.macroClass = mapped
          } else if (!rootStep.effectiveClassMap.preserveOriginal) {
            // Unmapped class, skip entirely. Recorded as `class-filter`: the
            // trace's model-saw count includes these boxes, so leaving them
            // out of the discard trail would make the ghost overlay disagree
            // with its own pill ("3 hidden", 1 ghost drawn).
            ;(discarded ??= []).push({
              bbox: [mutable.bbox[0], mutable.bbox[1], mutable.bbox[2], mutable.bbox[3]],
              macroClass: mutable.macroClass,
              score: mutable.score,
              reason: 'class-filter',
            })
            continue
          }
        }

        // D715/D730: the model declares a label supply and this raw class
        // names that step's effect → the detection carries it as a linked
        // label (score 0 here; the runner decides whether the camera uses it).
        for (const linked of linkedLabelsFor(
          rootStep.rootSupplies,
          det.class,
          mutable.macroClass,
          rootStep.modelId,
        )) {
          mutable.ownLabels.push(linked)
        }

        // Apply per-step macro class filter from settings.enabledMacroClasses
        // + per-macro minConfidence sliders (Phase 6 step rework).
        const filterVerdict = this.macroFilterVerdict(
          mutable.macroClass,
          mutable.score,
          rootStep.settings,
        )
        if (filterVerdict !== 'pass') {
          ;(discarded ??= []).push({
            bbox: [mutable.bbox[0], mutable.bbox[1], mutable.bbox[2], mutable.bbox[3]],
            macroClass: mutable.macroClass,
            score: mutable.score,
            reason: filterVerdict,
          })
          if (debug)
            console.log(
              `[executor] drop det macro=${mutable.macroClass} score=${mutable.score} (${filterVerdict})`,
            )
          continue
        }

        // Full-frame phantom guard (cam-101 "vehicle 52%" over an empty scene):
        // drop a near-full-frame / full-column / full-row LOW-confidence box so
        // it never reaches the overlay, tracker occupancy or events. Earliest
        // post-inference point where ALL consumers benefit. Object-detection
        // roots only (this loop); score-aware — a genuine high-confidence
        // close-up subject survives. The confidence bar can be threaded from
        // step settings (no new cap method) via `fullFrameGuardMaxConfidence`.
        const fullFrameBar = rootStep.settings?.['fullFrameGuardMaxConfidence']
        const fullFrameHardArea = rootStep.settings?.['fullFrameGuardHardAreaRatio']
        if (
          isFullFramePhantomDetection(
            mutable.bbox,
            imageWidth,
            imageHeight,
            mutable.score,
            typeof fullFrameBar === 'number' ? fullFrameBar : undefined,
            typeof fullFrameHardArea === 'number' ? fullFrameHardArea : undefined,
          )
        ) {
          // A DROPPED detection must leave a trace. This branch used to write
          // a `console.log` behind the `debug` verbosity flag, so in normal
          // operation the guard removed detections with no record at all —
          // and "how often does this fire, and on what?" was unanswerable.
          //
          // It was bounded on the assumption that full-frame phantoms are
          // rare, with the note that a flood would itself be the finding. It
          // flooded: device 101 emits a standing full-frame `vehicle` phantom
          // (score ~0.62, areaRatio 0.949) and this wrote DOZENS of INFO lines
          // per second on 2026-08-02. The finding stands — that camera needs
          // looking at — but the volume now costs more than the record is
          // worth and buries every other line in the stream.
          //
          // So: the FIRST of each (device, class) still logs in full, because
          // the example is what makes it actionable, and after that the pair is
          // counted and summarised once a minute. The rate survives; the
          // wallpaper does not.
          const sample = this.dropSampler.record(deviceId, String(mutable.macroClass), occasion)
          if (sample.summaryCount !== null) {
            this.opts.logger?.info('full-frame phantom guard: still dropping', {
              tags: logTags,
              meta: {
                macroClass: mutable.macroClass,
                suppressed: sample.summaryCount,
                windowMs: DROP_SUMMARY_INTERVAL_MS,
                hint: 'a standing full-frame phantom — check the camera framing / model, not the guard',
              },
            })
          }
          if (sample.logExample)
            this.opts.logger?.info('full-frame phantom guard: detection dropped', {
              tags: logTags,
              meta: {
                macroClass: mutable.macroClass,
                score: mutable.score,
                bbox: mutable.bbox,
                frameWidth: imageWidth,
                frameHeight: imageHeight,
                // `mutable.bbox` is `[x1, y1, x2, y2]` in absolute pixels.
                areaRatio:
                  imageWidth > 0 && imageHeight > 0
                    ? Math.round(
                        (((mutable.bbox[2] - mutable.bbox[0]) *
                          (mutable.bbox[3] - mutable.bbox[1])) /
                          (imageWidth * imageHeight)) *
                          1000,
                      ) / 1000
                    : undefined,
                bar: typeof fullFrameBar === 'number' ? fullFrameBar : undefined,
                hardAreaRatio:
                  typeof fullFrameHardArea === 'number' ? fullFrameHardArea : undefined,
              },
            })
          ;(discarded ??= []).push({
            bbox: [mutable.bbox[0], mutable.bbox[1], mutable.bbox[2], mutable.bbox[3]],
            macroClass: mutable.macroClass,
            score: mutable.score,
            reason: 'full-frame-guard',
          })
          continue
        }

        // Survived the guard but IS full-frame: the case the hard-area cut
        // exists for. Counted here because an offline sweep of stored events
        // is what found the six on device 101, and that is not a monitoring
        // strategy. Originally `warn` on the assumption this is rare; live
        // it fired 34×/min on a phantom-prone camera (2026-08-01), which is
        // wallpaper, not a page — WARN is reserved for lines an operator
        // should act on individually. `info` keeps the per-camera trace
        // (tags.deviceId groups it) and the `hint` names the remediation.
        if (
          isFullFrameSurvivor(
            mutable.bbox,
            imageWidth,
            imageHeight,
            mutable.score,
            typeof fullFrameBar === 'number' ? fullFrameBar : undefined,
          )
        ) {
          this.opts.logger?.info('full-frame box SURVIVED the guard on score', {
            tags: logTags,
            meta: {
              macroClass: mutable.macroClass,
              score: mutable.score,
              bbox: mutable.bbox,
              areaRatio:
                imageWidth > 0 && imageHeight > 0
                  ? Math.round(
                      (((mutable.bbox[2] - mutable.bbox[0]) * (mutable.bbox[3] - mutable.bbox[1])) /
                        (imageWidth * imageHeight)) *
                        1000,
                    ) / 1000
                  : undefined,
              bar: typeof fullFrameBar === 'number' ? fullFrameBar : undefined,
              hint: 'arm fullFrameGuardHardAreaRatio on this camera if these are phantoms',
            },
          })
        }

        // Execute children for this detection. Child failures are
        // logged but do not drop the parent detection from the frame —
        // partial enrichment is preferable to losing the root entirely.
        try {
          await this.executeChildren(
            rootStep.children,
            mutable,
            rootView?.jpegProvider ?? fullFrameJpegProvider,
            imageWidth,
            imageHeight,
            traceBuilder,
            stepTimings,
            ctx,
            poolAgg,
            runOpts?.plane,
            deviceId,
            nativeCropProvider,
          )
        } catch (err) {
          this.opts.logger?.warn('Pipeline child execution failed — keeping parent detection', {
            tags: logTags,
            meta: {
              rootStepId: rootStep.stepId,
              parentClass: mutable.macroClass,
              parentScore: mutable.score,
              error: errMsg(err),
            },
          })
        }

        firstLevel.push(mutable)
      }

      if (rootChildCandidates.length > 0) {
        const attached = attachRootChildBoxes(
          rootChildCandidates,
          firstLevel.slice(firstLevelStart),
          rootStep.modelId,
          idGen,
        )
        details.push(...attached.details)
        // A root box nothing contains makes nothing — recorded on the discard
        // trail like any class the classMap does not keep.
        for (const c of attached.uncontained) {
          ;(discarded ??= []).push({
            bbox: [c.bbox[0], c.bbox[1], c.bbox[2], c.bbox[3]],
            macroClass: c.supply.childClass,
            score: c.score,
            reason: 'class-filter',
          })
        }
      }
    }

    const totalMs = Date.now() - startMs

    const result = buildFrameResult({
      deviceId,
      width: imageWidth,
      height: imageHeight,
      firstLevel,
      details,
      discarded,
      ...(rootShed.count > 0 ? { shed: { reason: rootShed.reasons[0] ?? 'pool-overload' } } : {}),
      stepTimings,
      totalMs,
      engine: this.opts.engineRuntime,
      debug,
      timestamp: Date.now(),
      poolTimings: {
        preprocessMs: Math.round(poolAgg.preprocessMs * 100) / 100,
        predictMs: Math.round(poolAgg.predictMs * 100) / 100,
        batchSize: poolAgg.batchSize,
      },
    })

    const trace = traceBuilder.build(firstLevel.length + details.length)

    return { result, trace }
  }

  // -------------------------------------------------------------------------
  // Private: root-level classifier/embedding synthesis (task 6b)
  // -------------------------------------------------------------------------

  /**
   * Build a full-frame `MutableObjectDetection` for a ROOT step whose engine
   * output is a classification/embedding rather than detections — there is
   * no detector to bound a smaller box, so the synthesized detection covers
   * the entire input frame (`bbox = [0, 0, imageWidth, imageHeight]`).
   * `macroClass` is the step's own output semantic (`outputClasses[0]`,
   * falling back to `inputClasses[0]` when `outputClasses` is empty, then
   * the step id as a last resort so the field is never empty). `score` is
   * the output's own confidence when it has one (the classifier's top-1
   * score, an OCR read's `confidence`) — an embedding carries no
   * confidence, so it defaults to 1.
   */
  private synthesizeRootDetection(
    output: EnrichmentOutput,
    rootStep: ExecutableStep,
    idGen: FrameIdGenerator,
    rootStepLatencyMs: number,
    imageWidth: number,
    imageHeight: number,
  ): MutableObjectDetection {
    const macroClass =
      rootStep.definition.outputClasses[0] ??
      rootStep.definition.inputClasses?.[0] ??
      rootStep.stepId
    const score =
      output.kind === 'classifications'
        ? (output.classifications[0]?.score ?? 1)
        : output.kind === 'text'
          ? output.confidence
          : 1

    return toMutableRootDetection(
      { class: macroClass, score, bbox: [0, 0, imageWidth, imageHeight] },
      rootStep,
      idGen,
      rootStepLatencyMs,
    )
  }

  // -------------------------------------------------------------------------
  // Private: crop-zone root frame preparation
  // -------------------------------------------------------------------------

  /**
   * Crop the full frame to a `crop-zone` root's absolute-pixel zone bbox and
   * return the cropped JPEG input + the exact origin used, so detections can be
   * re-projected. Returns null (⇒ full-frame fallback) when the bbox is
   * degenerate or the crop/encode fails — a package frame is never dropped for
   * a crop failure. The origin is computed to match `cropJpeg`'s clamp+round
   * exactly so the re-projection is pixel-accurate.
   */
  private async prepareCropZoneInput(
    cropZoneBbox: AbsoluteBbox,
    fullFrameJpegProvider: () => Promise<Buffer>,
    imageWidth: number,
    imageHeight: number,
    deviceId: number,
  ): Promise<{
    input: InferenceInput
    width: number
    height: number
    origin: AbsoluteBbox
  } | null> {
    if (isBboxDegenerate(cropZoneBbox)) return null
    try {
      const fullFrameJpeg = await fullFrameJpegProvider()
      const crop = await cropJpeg(fullFrameJpeg, cropZoneBbox, imageWidth, imageHeight)
      // Match cropJpeg's extract origin (max(0, round(bbox0/1))) so the
      // re-projection origin equals the actual crop origin to the pixel.
      const ox = Math.max(0, Math.round(cropZoneBbox[0]))
      const oy = Math.max(0, Math.round(cropZoneBbox[1]))
      return {
        input: withInferenceDeviceId({ kind: 'jpeg', data: crop.jpeg }, deviceId),
        width: crop.width,
        height: crop.height,
        origin: [ox, oy, ox + crop.width, oy + crop.height],
      }
    } catch (err) {
      this.throttledWarn(
        `crop-zone-prep:${deviceId}`,
        30_000,
        'crop-zone frame preparation failed — running package-detection full-frame',
        { error: errMsg(err) },
        deviceId,
      )
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Private: step execution
  // -------------------------------------------------------------------------

  private async executeStep(
    step: ExecutableStep,
    input: InferenceInput,
    inputWidth: number,
    inputHeight: number,
    inputType: 'full-frame' | 'crop-roi',
    _parentBbox: AbsoluteBbox | undefined,
    parentClass: string | undefined,
    traceBuilder: ExecutionTraceBuilder,
    stepTimings: FrameStepTiming[],
    poolAgg: PoolStageAccumulator,
    /**
     * Optional shed accumulator — passed by `run()` for ROOT steps only, so
     * a pool shed can surface as the frame-level `FrameResult.shed` marker.
     * Child call sites omit it: a shed child loses one enrichment, not the
     * frame's root inference.
     */
    shedAgg?: RootShedAccumulator,
  ): Promise<StepOutput | null> {
    const preprocessStart = Date.now()
    const preprocessMs = Date.now() - preprocessStart

    // Inference
    const inferenceStart = Date.now()
    let engineOutput: import('@camstack/types').EngineOutput

    try {
      engineOutput = await step.engine.infer(input)
    } catch (err) {
      const errorMsg = errMsg(err)
      const errorOutput: StepOutput = { kind: 'detections', detections: [] }

      if (traceBuilder.isActive) {
        traceBuilder.addStep({
          stepId: step.stepId,
          modelId: step.modelId,
          slot: step.definition.slot,
          postprocessor: step.definition.postprocessor,
          preprocessMs,
          inferenceMs: Date.now() - inferenceStart,
          postprocessMs: 0,
          inputType,
          inputWidth,
          inputHeight,
          parentDetection: parentClass,
          output: errorOutput,
          error: errorMsg,
        })
      }

      stepTimings.push({
        source: step.stepId,
        modelId: step.modelId,
        ms: Date.now() - preprocessStart,
        detectionCount: 0,
      })

      throw new Error(`Inference failed for step "${step.stepId}": ${errorMsg}`, { cause: err })
    }

    // Overload shed (`EngineOutput.dropped`): the pool DELIBERATELY did not
    // run inference for this frame — skip it the way a dropped frame is
    // skipped everywhere else. No postprocess, no detections, no error. The
    // pool keeps the authoritative running total (`getDroppedResponseCount`)
    // and its own sampled debug line, so nothing is logged here. Root-level
    // sheds are recorded into `shedAgg` so the frame carries a first-class
    // `shed` marker instead of masquerading as "no detections".
    if (engineOutput.dropped === true) {
      if (shedAgg) {
        shedAgg.count += 1
        shedAgg.reasons.push(engineOutput.shedReason ?? 'pool-overload')
      }
      stepTimings.push({
        source: step.stepId,
        modelId: step.modelId,
        ms: Date.now() - preprocessStart,
        detectionCount: 0,
      })
      if (traceBuilder.isActive) {
        traceBuilder.addStep({
          stepId: step.stepId,
          modelId: step.modelId,
          slot: step.definition.slot,
          postprocessor: step.definition.postprocessor,
          preprocessMs,
          inferenceMs: Date.now() - inferenceStart,
          postprocessMs: 0,
          inputType,
          inputWidth,
          inputHeight,
          parentDetection: parentClass,
          output: { kind: 'detections', detections: [] },
          error: `shed:${engineOutput.shedReason ?? 'pool-overload'}`,
        })
      }
      return null
    }

    // Prefer python-reported `inferenceMs` (wall measured inside the
    // pool: python preprocess + predict, NOT IPC). The python pool dict
    // is exposed by PoolHandle.infer under `engineOutput.structured`;
    // the top-level `engineOutput.inferenceMs` is the TS-measured wall
    // (includes IPC stdin/stdout + window-accumulator wait), which
    // inflates the metric by 30-60ms per call. Falls back to the TS
    // wall only when the structured payload is absent (non-pool engines).
    const structured = (engineOutput.structured ?? {}) as {
      readonly inferenceMs?: number
      readonly preprocessMs?: number
      readonly predictMs?: number
      readonly batchSize?: number
    }
    const inferenceMs =
      typeof structured.inferenceMs === 'number'
        ? structured.inferenceMs
        : Date.now() - inferenceStart

    // Capture python-pool stage timings — surfaced via FrameDebug for the
    // benchmark UI. Multi-step pipelines accumulate; single-step (benchmark)
    // gets the actual values directly.
    if (typeof structured.preprocessMs === 'number') {
      poolAgg.preprocessMs += structured.preprocessMs
    }
    if (typeof structured.predictMs === 'number') {
      poolAgg.predictMs += structured.predictMs
    }
    if (typeof structured.batchSize === 'number' && structured.batchSize > poolAgg.batchSize) {
      poolAgg.batchSize = structured.batchSize
    }

    // Postprocess
    const postprocessStart = Date.now()
    const output = dispatchPostprocess(engineOutput, step.definition)
    const postprocessMs = Date.now() - postprocessStart

    // Record timing
    stepTimings.push({
      source: step.stepId,
      modelId: step.modelId,
      ms: preprocessMs + inferenceMs + postprocessMs,
      detectionCount: output.kind === 'detections' ? output.detections.length : 0,
    })

    // Record trace
    if (traceBuilder.isActive) {
      traceBuilder.addStep({
        stepId: step.stepId,
        modelId: step.modelId,
        slot: step.definition.slot,
        postprocessor: step.definition.postprocessor,
        preprocessMs,
        inferenceMs,
        postprocessMs,
        inputType,
        inputWidth,
        inputHeight,
        parentDetection: parentClass,
        output,
      })
    }

    return output
  }

  // -------------------------------------------------------------------------
  // Private: children execution
  // -------------------------------------------------------------------------

  private async executeChildren(
    children: readonly ExecutableStep[],
    parentDetection: MutableObjectDetection,
    fullFrameJpegProvider: () => Promise<Buffer>,
    imageWidth: number,
    imageHeight: number,
    traceBuilder: ExecutionTraceBuilder,
    stepTimings: FrameStepTiming[],
    ctx: AssemblyContext,
    poolAgg: PoolStageAccumulator,
    plane: PipelineExecutionPlane | undefined,
    deviceId: number,
    nativeCropProvider?: NativeFaceCropProvider,
  ): Promise<void> {
    for (const child of children) {
      // Frame-plane dispatch (live per-frame runtime) runs ONLY root-plane
      // steps — crop children (a non-null `inputClasses` on the step
      // DEFINITION, not the always-array `ExecutableStep.inputClasses`) are
      // skipped entirely, before any child work including the lazy
      // `fullFrameJpegProvider()` JPEG encode below. They're served
      // per-track via a separate detail-subtree call (two-plane design).
      // Undefined/'full' preserves today's whole-tree behaviour.
      if (plane === 'frame' && child.definition.inputClasses !== null) {
        continue
      }

      // Schema-derived inputClasses route by parent's macroClass.
      // Empty/null inputClasses = root step, no filter at this level.
      if (!this.matchesInputClasses(parentDetection.macroClass, child.inputClasses)) {
        continue
      }

      // Per-step minimum parent score — skip child if the parent
      // detection's confidence is below the threshold. Avoids running
      // expensive child models (face-det, plate-det) on low-confidence
      // root detections. Configurable per-step via settings.minParentScore,
      // falls back to the step definition's defaultMinParentScore.
      const minParentScore =
        (child.settings?.minParentScore as number | undefined) ??
        child.definition?.defaultMinParentScore
      if (typeof minParentScore === 'number' && parentDetection.score < minParentScore) {
        // A face the detector kept but is not sure enough of to embed (D741:
        // detection floor 0.70, embedding gate 0.85) is work dropped on
        // purpose — said, throttled, per camera. Other children skip silently
        // as before: a low-score parent there is the common case.
        if (child.definition.models.find((m) => m.id === child.modelId)?.faceAlignment === true) {
          this.throttledWarn(
            `face-embed-score-floor:${child.stepId}:${deviceId}`,
            30_000,
            'face detected but below the embedding score floor — no embedding',
            {
              step: child.stepId,
              model: child.modelId,
              faceScore: parentDetection.score,
              minParentScore,
            },
            deviceId,
          )
        }
        continue
      }

      // Skip degenerate bboxes
      if (isBboxDegenerate(parentDetection.bbox)) {
        continue
      }

      try {
        const childStart = Date.now()

        // Lazily realize the JPEG buffer (cached by the provider) only
        // once a child crop is actually requested. Detection-only trees
        // pay nothing for the encode.
        const fullFrameJpeg = await fullFrameJpegProvider()

        // Face-recognition embedders (faceAlignment) need a landmark-aligned
        // crop, not a stretched bbox crop. Gate out faces too small to embed
        // reliably, then warp onto the canonical template using the parent
        // detail's 5 landmarks. Falls back to a plain crop when landmarks are
        // absent (older runners / detectors without keypoints).
        const modelEntry = child.definition.models.find((m) => m.id === child.modelId)
        let cropJpegBuf: Buffer
        let cropW: number
        let cropH: number
        if (modelEntry?.faceAlignment) {
          const minFaceSize = numericSetting(
            child.settings,
            'minFaceSize',
            DEFAULT_MIN_FACE_SIZE_PX,
          )
          const detShortSide = bboxShortSide(parentDetection.bbox)
          // Cheap floor: a genuinely degenerate face is skipped before any native
          // round-trip (native scale can't rescue a sub-floor detection).
          if (detShortSide < MIN_FACE_DETECTION_FLOOR_PX) {
            this.warnFaceTooSmall(child, detShortSide, minFaceSize, undefined, deviceId)
            continue
          }
          // LANDMARK-PRECISION FLOOR — evaluated ALWAYS, on the DETECTION
          // measurement, and BEFORE the `gateShortSide` substitution below.
          // That substitution (`nativeFaceShortSidePx ?? detShortSide`) answers
          // "does the embedder have enough pixels?", and a native crop can
          // legitimately rescue a small face there. It cannot rescue THIS: the
          // landmarks were regressed at detection scale and no amount of native
          // resolution makes them more accurate. Measured 2026-08-19, the native
          // size does not separate aligned crops from crops containing no face
          // at all (113 px vs 83 px) while the detection size does (28.2 vs
          // 16.5) — see `landmark-precision-gate.ts` for the full table and the
          // operator's floor choice.
          const landmarkFloor = numericSetting(
            child.settings,
            'minLandmarkFaceSize',
            DEFAULT_LANDMARK_PRECISION_FLOOR_PX,
          )
          const precision = landmarkPrecisionVerdict({
            detectionShortSidePx: detShortSide,
            floorPx: landmarkFloor,
          })
          if (precision !== null) {
            // A branch that drops work logs it — throttled per step+device
            // because this runs at frame rate.
            this.throttledWarn(
              `face-landmark-floor:${child.stepId}:${deviceId}`,
              30_000,
              'face detected but its landmarks are below the precision floor — no embedding',
              {
                step: child.stepId,
                model: child.modelId,
                detectionShortSidePx: Math.round(precision.detectionShortSidePx),
                minLandmarkFaceSizePx: precision.floorPx,
                tileW: imageWidth,
                tileH: imageHeight,
              },
              deviceId,
            )
            continue
          }
          const lms = parentDetection.landmarks
          if (lms && lms.length >= 5) {
            // Without a native provider bound to this frame, native can't rescue a
            // small face — apply the detection-space gate UP FRONT (today's
            // behaviour) so a too-small face never pays the align cost.
            if (!nativeCropProvider && detShortSide < minFaceSize) {
              this.warnFaceTooSmall(child, detShortSide, minFaceSize, undefined, deviceId)
              continue
            }
            // Design B: embed on the NATIVE face crop when a provider is bound to
            // this frame; otherwise fall back to the downscaled full-frame align.
            // ArcFace input stays `inputSize.width`² either way — only the crop
            // SOURCE changes, so model cost is unchanged.
            const aligned = await buildAlignedFaceCrop({
              fullFrameJpeg,
              faceBbox: parentDetection.bbox,
              landmarksImageSpace: lms,
              imageWidth,
              imageHeight,
              outSize: modelEntry.inputSize.width,
              ...(nativeCropProvider
                ? {
                    nativeCropProvider: nativeCropProvider,
                    nativeMaxWidth: NATIVE_FACE_CROP_MAX_WIDTH,
                  }
                : {}),
            })
            // Native-aware gate: measure against the NATIVE face size when the
            // crop came from a native surface (a face 20px in the 640-wide
            // detection frame is `native/detection ×` larger — embeddable);
            // otherwise fall back to the detection-space size (no regression).
            const gateShortSide = aligned.nativeFaceShortSidePx ?? detShortSide
            // Scale-collapse diagnostic (2026-07-23, zero-faces regression):
            // expose the native-crop vs region dimensions AND the tile the
            // detector ran on, both on the gate-out warn and (throttled) on a
            // pass, so a "native" crop served at detection resolution is
            // visible in the logs instead of silently gating every face.
            const faceDiag: Record<string, number> = {
              tileW: imageWidth,
              tileH: imageHeight,
              ...aligned.nativeDiag,
            }
            if (gateShortSide < minFaceSize) {
              this.warnFaceTooSmall(
                child,
                detShortSide,
                minFaceSize,
                aligned.source === 'native' ? gateShortSide : undefined,
                deviceId,
                faceDiag,
              )
              continue // face too small even at native resolution
            }
            this.throttledWarn(
              `face-embed-diag:${deviceId}`,
              30_000,
              'face embed accepted (scale diagnostic)',
              {
                step: child.stepId,
                detShortSidePx: Math.round(detShortSide),
                gateShortSidePx: Math.round(gateShortSide),
                source: aligned.source,
                ...faceDiag,
              },
              deviceId,
            )
            cropJpegBuf = aligned.jpeg
            cropW = aligned.width
            cropH = aligned.height
            // Persist the EXACT ArcFace input on the face detail so the gallery
            // can show the crop the embedding was computed from (1:1 with the
            // vector), not a separately captured natural crop. `parentDetection`
            // here is the `face` detail the embedder runs on. Carried verbatim to
            // post-analysis on the frame event — the alignment stays a SINGLE
            // implementation (this warp); post-analysis performs no re-alignment.
            parentDetection.faceAlignedCrop = cropJpegBuf.toString('base64')
            // Carry the NATIVE face size to downstream consumers: the detail's
            // bbox is detection-frame px (≈6× smaller on a 4K camera), and the
            // post-analysis min-face gate measuring THAT silently discarded
            // every distant-camera face (2026-07-22). Native-aware end-to-end.
            if (aligned.nativeFaceShortSidePx !== undefined) {
              parentDetection.nativeFaceShortSidePx = aligned.nativeFaceShortSidePx
            }
          } else {
            // No landmarks → can't align or native-scale; gate on detection size.
            if (detShortSide < minFaceSize) {
              this.warnFaceTooSmall(child, detShortSide, minFaceSize, undefined, deviceId)
              continue
            }
            const crop = await cropJpeg(
              fullFrameJpeg,
              parentDetection.bbox,
              imageWidth,
              imageHeight,
            )
            cropJpegBuf = crop.jpeg
            cropW = crop.width
            cropH = crop.height
          }
        } else {
          // Non-face crop child. For a LEAF child (no grandchildren — e.g.
          // `plate-ocr`, leaf classifiers) prefer a NATIVE-resolution cut of the
          // ROI, mirroring the face path: the child model reads native pixels
          // instead of the downscaled parent tile — the plate-OCR accuracy fix.
          // Restricted to leaves because a cropper child that spawns
          // grandchildren re-projects their bboxes with the UNSCALED
          // `transformBboxToImageSpace` (crop-pixel == parent-bbox-pixel), which
          // a larger native crop would break. A native miss/degenerate (or no
          // provider bound) falls back to today's `cropJpeg` tile — never an
          // upscale.
          // A plate READER may want context the detector box does not include
          // (the deleted `yolov8n-plate` clipped the leading glyph of an oblique
          // plate; `yolox-tiny-plate` boxes are bigger, so the slot reader's
          // margin dropped to 5%, D719). The margin is per-reader and declared
          // once, next to the two other things that differ between them
          // (rectify, size floor).
          // The MODEL's postprocessor, not the step's. `plate-ocr` is declared
          // `ctc` and its default model overrides that to `plate-slots`; reading
          // the step here would prepare CTC pixels (quad-warp, 85px floor) for a
          // reader the pool decodes with the fixed-slot path — the exact
          // mismatch that scores 4/21 instead of 19/21 and errors nowhere.
          const cropPolicy = resolvePlateOcrCropPolicy(
            resolveEffectivePostprocessor(child.definition, child.modelId),
          )
          // A box the ROOT model drew (D730) gets the root-box margin, not the
          // reader's own: the margin belongs to whoever drew the box.
          const marginFraction = cropPolicy
            ? plateOcrMarginFraction(cropPolicy, parentDetection.rootSupplied !== undefined)
            : 0
          const cropBbox = cropPolicy
            ? expandBbox(parentDetection.bbox, marginFraction, imageWidth, imageHeight)
            : parentDetection.bbox
          const nativeChild =
            nativeCropProvider && child.children.length === 0
              ? await nativeChildCrop(
                  nativeCropProvider,
                  cropBbox,
                  imageWidth,
                  imageHeight,
                  NATIVE_CHILD_CROP_MAX_WIDTH,
                )
              : null
          if (nativeChild) {
            cropJpegBuf = nativeChild.jpeg
            cropW = nativeChild.width
            cropH = nativeChild.height
          } else {
            const crop = await cropJpeg(fullFrameJpeg, cropBbox, imageWidth, imageHeight)
            cropJpegBuf = crop.jpeg
            cropW = crop.width
            cropH = crop.height
          }

          // Plate min-size gate (mirror of the face path's min-face gate),
          // measured on the ACTUAL crop this reader will see — native when the
          // native fetch succeeded, else the detection-space tile, and in both
          // cases already carrying the reader's margin. The floor itself is
          // per-reader (`plate-ocr-crop-policy.ts`): for the CTC recognizer it is
          // a correctness gate against confident garbage, for the slot reader
          // just a "do not spend an inference on this" bound, its correctness
          // being the per-character confidence floor instead.
          //
          // The skip is logged at info: this branch DROPS work, and a silent
          // drop reads as "the camera never saw a plate".
          if (cropPolicy) {
            const plateLongSidePx = Math.max(cropW, cropH)
            if (plateLongSidePx < cropPolicy.minLongSidePx) {
              this.opts.logger?.info('plate ROI too small for OCR — skipping', {
                tags: { deviceId },
                meta: {
                  step: child.stepId,
                  model: child.modelId,
                  plateLongSidePx: Math.round(plateLongSidePx),
                  plateShortSidePx: Math.round(Math.min(cropW, cropH)),
                  minPlateLongSidePx: cropPolicy.minLongSidePx,
                  marginFraction,
                  boxFrom: parentDetection.rootSupplied !== undefined ? 'root-model' : 'step',
                  source: nativeChild ? 'native' : 'detection-tile',
                },
              })
              continue
            }
          }

          // GEOMETRY for the OCR leaf ONLY, and only for a reader whose policy
          // ASKS for it — never faces (landmark alignment), never cropper/parent
          // children. The per-step `rectify` toggle can still switch it off, but
          // it cannot switch it on for a reader that does not want it: the
          // quad-warp exists to rescue a GENERIC text recognizer from a tilted
          // plate's aspect ratio, and handing that same strip to a plate reader
          // trained on detector boxes costs it 15 of its 19 exact reads.
          //
          // Two rectifiers, tried in order, because they fail differently:
          //
          //  1. `warpPlateJpeg` — find the plate blob in the tile and sample
          //     its quadrilateral onto a canonical 4.7:1 × 64px strip. This
          //     fixes ASPECT and TILT together and is what actually reads cam
          //     102: on the 2026-08-20 ground-truth set it takes exact reads
          //     from 0/21 to 4/21 and character accuracy from 4.8% to 42.9%.
          //  2. `rectifyPlateJpeg` (projection-profile deskew) — the fallback
          //     when no plausible plate blob is found (night, a plate that is
          //     not the brightest thing in the ROI). It corrects rotation only,
          //     and by design answers 0° when the optimum is unbracketed (D186).
          //
          // Whichever fires applies to the tile that fed OCR (native ROI or the
          // fallback tile above). A miss on both keeps the tile untouched — the
          // un-warped crop is the floor, never a guessed quad.
          if (cropPolicy?.rectify && child.settings?.['rectify'] !== false) {
            try {
              const warped = await warpPlateJpeg(cropJpegBuf)
              if (warped) {
                cropJpegBuf = warped.jpeg
                cropW = warped.width
                cropH = warped.height
                this.opts.logger?.info('plate crop warped before OCR', {
                  tags: { deviceId },
                  meta: { step: child.stepId, width: cropW, height: cropH },
                })
              } else {
                const rectified = await rectifyPlateJpeg(cropJpegBuf)
                if (rectified) {
                  cropJpegBuf = rectified.jpeg
                  cropW = rectified.width
                  cropH = rectified.height
                  this.opts.logger?.info('plate crop deskewed before OCR', {
                    tags: { deviceId },
                    meta: {
                      step: child.stepId,
                      angleDeg: Number(rectified.angleDeg.toFixed(2)),
                      width: cropW,
                      height: cropH,
                    },
                  })
                }
              }
            } catch {
              // Rectification is best-effort — any failure keeps the original tile.
            }
          }
        }

        const childOutput = await this.executeStep(
          child,
          withInferenceDeviceId({ kind: 'jpeg', data: cropJpegBuf }, deviceId),
          cropW,
          cropH,
          'crop-roi',
          parentDetection.bbox,
          parentDetection.macroClass,
          traceBuilder,
          stepTimings,
          poolAgg,
        )
        const childMs = Date.now() - childStart

        // Shed under overload — the crop was deliberately skipped by the
        // pool. The parent detection stands unenriched; next child.
        if (childOutput === null) continue

        // EVERY plate read reaches the log, tagged with the camera. A track
        // yields up to `cadence.maxPerTrack` reads of the same physical plate
        // and post-analysis votes over them; how much those reads AGREE is the
        // cheap per-camera measure of whether the plate pixels are good enough
        // ("why is 102 worse than 101?"). While only the winner was logged that
        // number could not be computed at all.
        if (child.definition.postprocessor === 'ctc' && childOutput.kind === 'text') {
          this.opts.logger?.info('plate OCR read', {
            tags: { deviceId },
            meta: {
              step: child.stepId,
              model: child.modelId,
              text: childOutput.text,
              confidence: Number(childOutput.confidence.toFixed(3)),
              formatValid: childOutput.formatValid ?? null,
              tilePx: `${cropW}x${cropH}`,
            },
          })
        }

        // Apply child output to parent detection (may spawn detail
        // entries into ctx.details when the child is a cropper).
        const detailsBefore = ctx.details.length
        applyChildOutput(parentDetection, child, childOutput, childMs, ctx)

        // For cropper outputs (detections), recurse into grandchildren
        // on the freshly-created detail entries.
        if (childOutput.kind === 'detections' && child.children.length > 0) {
          const newDetails = ctx.details.slice(detailsBefore)
          for (const detail of newDetails) {
            // Transform detail bbox to image space (was produced in
            // crop coordinates by the cropper child).
            detail.bbox = transformBboxToImageSpace(detail.bbox, parentDetection.bbox)

            // Landmarks (face keypoints) come in the same crop-relative space —
            // shift them by the parent ROI origin so a downstream alignment
            // step receives absolute image-space coordinates.
            if (detail.landmarks) {
              const [px1, py1] = parentDetection.bbox
              detail.landmarks = detail.landmarks.map((l) => ({
                x: l.x + px1,
                y: l.y + py1,
              }))
            }

            // Recurse: grandchildren run directly on the detail.
            await this.executeChildren(
              child.children,
              detail,
              fullFrameJpegProvider,
              imageWidth,
              imageHeight,
              traceBuilder,
              stepTimings,
              ctx,
              poolAgg,
              plane,
              deviceId,
              nativeCropProvider,
            )
          }
        }
      } catch (err) {
        // Step failure: the error is recorded in the trace via `executeStep`,
        // but the trace is not visible in the live log — surface it (throttled)
        // so a persistently-failing child model (e.g. an embedder rejecting its
        // input layout) isn't a silent, days-long degradation. Siblings still
        // continue so one bad model doesn't break the whole frame.
        this.throttledWarn(
          `child-fail:${child.stepId}:${deviceId}`,
          15_000,
          'pipeline child step failed',
          {
            step: child.stepId,
            model: child.modelId,
            error: errMsg(err),
          },
          deviceId,
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  private matchesInputClasses(className: string, inputClasses: readonly string[]): boolean {
    if (inputClasses.length === 0) return true
    return inputClasses.includes(className)
  }

  /**
   * Apply the object-detection step's macro filter + per-macro
   * minConfidence sliders introduced in the Phase 6 step rework.
   *
   * Returns WHICH gate failed rather than a bare boolean so the
   * discard trail can label the dropped box with the honest reason
   * (`class-filter` vs `below-threshold`) — the two are remediated
   * differently (enable the class vs lower a slider).
   *
   * Expected `settings` shape:
   *   - `enabledMacroClasses`: readonly string[] (e.g. ['person','vehicle','animal']).
   *     Empty array = all allowed (legacy behaviour).
   *   - `minConfidence<Macro>`: number (e.g. `minConfidencePerson: 0.5`)
   */
  private macroFilterVerdict(
    macroClass: string,
    score: number,
    settings?: Readonly<Record<string, unknown>>,
  ): 'pass' | 'class-filter' | 'below-threshold' {
    // ONE authority, asked by both roots — see `macro-gate.ts`. It used to live
    // here, which was right while the executor was the only root detector.
    return macroGateVerdict(macroClass, score, settings)
  }
}
