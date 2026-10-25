/**
 * Two-plane design (detail plane): run a tracked detection's configured
 * CHILD steps (embedding, classifier, refiner — `inputClasses !== null`)
 * on-demand, per-track, instead of on every frame. Backs the
 * `pipelineRunner.runDetailSubtree` cap method.
 *
 * Deliberately deps-injected and framework-free so the algorithm (crop
 * padding/mapping, step-tree matching, bbox reprojection) is unit-testable
 * without a live addon / broker / decode worker. `index.ts` wires the real
 * deps (attachment lookup + catalog, the node-local native-crop lease, and
 * `pipelineExecutor.runPipeline`).
 *
 * ── Root-step promotion (investigated, see task-6 report) ──────────────
 * `PipelineExecutor.run()` treats every entry of the `steps` array handed
 * to `runPipeline` as a ROOT — `buildExecutableTree` builds a root node for
 * every enabled top-level step regardless of its catalog `inputClasses`,
 * and the executor's root loop runs it unconditionally against the crop
 * (no `matchesInputClasses` gate — that gate only applies to CHILDREN).
 * So a step like `face-detection` (catalog slot `'cropper'`, `inputClasses:
 * ['person']`) runs fine as a synthetic root: it produces `kind:'first-level'`
 * detections from the crop, and its OWN nested children (`face-embedding`)
 * still execute normally via `executeChildren`, landmarks/alignment
 * included. Confirmed via `packages/addon-pipeline/src/detection-pipeline/pipeline/{tree-builder,executor}.ts`
 * — no executor change was needed for this task's named examples
 * (face-detection→face-embedding, plate-detection→plate-ocr).
 *
 * Classifier/embedding-shaped roots (e.g. `clip-embedding`,
 * `slot:'classifier'` steps matching the parent class directly) are
 * supported: `PipelineExecutor.run()` synthesizes a full-frame detection
 * for a root whose output kind isn't `'detections'` and attaches the
 * classification/embedding to it, so those steps return one detail
 * covering the whole parent crop.
 */
import type {
  DetailCropConvention,
  DetailResult,
  FrameHandle,
  FrameResult,
  IScopedLogger,
  NativeCropRef,
  ObjectDetection,
  PipelineStepInputOutput,
  RunDetailSubtreeInput,
  RunDetailSubtreeResult,
  ScoredLabel,
  SuppliedRootOutput,
} from '@camstack/types'
import { CROP_SUPPLY_SOURCES, deriveDetailCropRect } from '@camstack/types'
import { getSharp } from '../shared/lazy-sharp.js'
import type { DetailStepPlacement } from './device-jump.js'
import {
  FACE_GUARD_UNAVAILABLE_MESSAGE,
  FACE_OUTSIDE_PARENT_MESSAGE,
  type FaceOutsideParentDrop,
  faceCentreInsideParent,
  faceOutsideParentMeta,
} from './face-parent-geometry.js'
import type { NativeCropMiss } from './native-crop-tier.js'
import { refineRootFace } from './root-face-refine.js'

/**
 * The not-attached case, DISCRIMINATED from the two `null` outcomes ("no
 * matching step" / "no crop source"). The distinction matters to the caller:
 * `null` is about THIS dispatch (a fresh frame may succeed), the refusal is
 * about the camera's SESSION state — no pixel rung can recover from it, so the
 * dispatcher must stop the ladder instead of burning two more doomed RPCs.
 * `index.ts` converts it to the wire-crossing marker error
 * (`detail-park.ts`); it exists as a value here so the pure algorithm stays
 * throw-free and unit-testable.
 */
export interface DetailNotAttachedRefusal {
  readonly refusal: 'not-attached'
}

/**
 * The frame handle the dispatch named is past the native lease age bound
 * (`NATIVE_CROP_LEASE_MAX_AGE_MS`), and no other rung it carried resolved.
 * Unlike the `null` "no crop source" outcome this is FINAL for the handle: the
 * registry refused it and will refuse it on every later ask, so the caller
 * must stop naming it (retire the handle, fall back per its own ladder)
 * rather than re-dispatch the same doomed ask each tick (D688). Every other
 * native miss stays a `null` — the refusal is the registry's own verdict, not a
 * guess from a miss.
 */
export interface DetailHandleExpiredRefusal {
  readonly refusal: 'handle-expired'
  /** Age of the handle when it was refused (same process, same clock). */
  readonly handleAgeMs: number | null
}

/** What {@link runDetailSubtree} produces when it does not short-circuit to `null`. */
export type DetailSubtreeOutcome =
  | RunDetailSubtreeResult
  | DetailNotAttachedRefusal
  | DetailHandleExpiredRefusal

/** Did the subtree run refuse because the camera is not attached (park lapsed)? */
export function isDetailNotAttachedRefusal(
  outcome: DetailSubtreeOutcome,
): outcome is DetailNotAttachedRefusal {
  return 'refusal' in outcome && outcome.refusal === 'not-attached'
}

/** Did the subtree run refuse because the named frame handle is past its lease age bound? */
export function isDetailHandleExpiredRefusal(
  outcome: DetailSubtreeOutcome,
): outcome is DetailHandleExpiredRefusal {
  return 'refusal' in outcome && outcome.refusal === 'handle-expired'
}

/** A `{x,y,w,h}` rectangle — reused for both pixel and normalized spaces. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Frame-space pixel rectangle. */
export type PixelRect = Rect
/** Normalized `[0,1]` rectangle (the `getNativeCrop` bbox convention). */
export type NormBbox = Rect

/** A resolved crop ready to feed `runPipeline` — jpeg bytes + the mapping back to frame space. */
export interface CropSource {
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
  /** The padded, clamped rectangle this crop covers, in FRAME-space pixels. */
  readonly frameSpace: PixelRect
  /**
   * Where the pixels came from:
   * - `native` — the frame's retained native surface (a `getNativeCrop` HIT),
   *   so leaf children may re-cut their ROI at native resolution;
   * - `derived` — the runner cut it out of the caller's FULL FRAME
   *   (`input.frameJpeg`) using {@link DetailSubtreeDeps.resolveCropConvention};
   *   same rectangle as `native`, but there is no live surface to re-cut from;
   * - `fallback` — the caller's pre-cut `cropJpeg` tile, taken as-is (no live
   *   native reference — children stay on the tile).
   */
  readonly source: 'native' | 'derived' | 'fallback'
}

/** Minimal catalog lookup shape `findMatchingDetailSteps` needs — satisfied by `StepDefinition`. */
export interface StepClassDefinition {
  readonly inputClasses: readonly string[] | null
}

/**
 * What the node-local native-lease fetch produced: the pixels, or the REASON it
 * produced none.
 *
 * `null` is still accepted (a fetch that cannot say why), but a runner that
 * knows the classification must return it — the drop line downstream is the
 * only place a caller ever learns whether the window was too small or its own
 * request arrived too late, and it used to end at a bare `null`.
 */
export type NativeCropFetch = Omit<CropSource, 'source'> | NativeCropMiss | null

/** Did the native-lease fetch report a miss (rather than return pixels)? */
export function isNativeCropMiss(fetch: NonNullable<NativeCropFetch>): fetch is NativeCropMiss {
  return 'miss' in fetch
}

export interface DetailSubtreeDeps {
  /** From the attach config's step tree; `null` = camera not attached. */
  resolveChildSteps(
    deviceId: number,
    parentClassName: string,
    filter?: readonly string[],
  ): readonly PipelineStepInputOutput[] | null
  /** Node-local native-crop lease (same internal path `getNativeCrop` uses).
   *  `source` is stamped by {@link resolveCrop} (`'native'`), so the dep returns
   *  only the pixels + frame-space mapping — or a {@link NativeCropMiss}. */
  getNativeCrop(
    deviceId: number,
    handle: FrameHandle,
    paddedBbox: NormBbox,
  ): Promise<NativeCropFetch>
  /**
   * Node-local `pipelineExecutor.runPipeline` with `plane: 'full'`. `deviceKey`
   * (step-tree device jump, phase 1) selects WHICH of the node's inference-device
   * pools runs this subtree; absent ⇒ the runner's per-camera default. Resolved
   * per top-level enrichment step via {@link DetailSubtreeDeps.placeStep}.
   */
  runPipeline(
    steps: readonly PipelineStepInputOutput[],
    imageJpeg: Buffer,
    deviceId: number,
    deviceKey?: string,
    /**
     * NATIVE child-crop reference, forwarded to the executor so a leaf child
     * (plate-ocr, face-embedding, leaf classifiers) re-cuts its ROI at native
     * resolution from the frame surface. Set ONLY when the crop came from the
     * native surface (a frameHandle HIT); absent ⇒ tile-crop children.
     */
    nativeCropRef?: NativeCropRef,
    /**
     * The root model's boxes standing in for the subtree root's inference
     * (D730) — in the PIXELS of `imageJpeg`. Absent ⇒ the root step infers.
     */
    suppliedRoot?: SuppliedRootOutput,
  ): Promise<FrameResult | null>
  /**
   * Step-tree device jump — place a top-level enrichment `step` (and the
   * children that ride its call) on a same-node inference device, and hand
   * back the step AS IT MUST RUN there: a jumped subtree carries the TARGET
   * device's provisioning (D650). `deviceKey: undefined` ⇒ the runner default.
   * Optional: absent ⇒ no jump (every step inherits the camera's elected
   * device, as sent). The impl owns the jump log and the loud
   * once-per-(camera,step) warn when nothing on the node can run the step.
   */
  placeStep?(deviceId: number, step: PipelineStepInputOutput): DetailStepPlacement
  /**
   * The cluster-wide crop convention (padding ratio + squaring) in force for
   * this camera. Deliberately NOT a local constant: `object-clip` is one shared
   * feature space, so the rectangle every encode path cuts must come from one
   * value. The runner resolves it from the `pipeline-orchestrator` global
   * settings; a failed read falls back to `DEFAULT_DETAIL_CROP_CONVENTION`,
   * which reproduces the historical live behaviour rather than inventing one.
   */
  resolveCropConvention(deviceId: number): DetailCropConvention
  /**
   * Where a DROPPED dispatch is announced. Every early return below produces a
   * line — a detail dispatch that yields nothing is otherwise indistinguishable
   * from one that was never made, and the rebuild's counters depend on knowing
   * the difference.
   */
  readonly logger: Pick<IScopedLogger, 'warn'>
  /**
   * Where a face the geometry guard dropped is announced (D662) — the runner
   * wires a per-camera rate-limited log (`FaceOutsideParentLog`). Absent ⇒ every
   * drop is a `logger.warn` line: never silent (D391), merely unthrottled.
   */
  recordFaceOutsideParent?(drop: FaceOutsideParentDrop): void
}

/** The class the geometry guard judges — the face detector's output. */
const FACE_CLASS = 'face'

/** Normalize a frame-space pixel rect to `[0,1]` by the given frame dims. */
export function normalizeRect(rect: PixelRect, frameWidth: number, frameHeight: number): NormBbox {
  return {
    x: rect.x / frameWidth,
    y: rect.y / frameHeight,
    w: rect.w / frameWidth,
    h: rect.h / frameHeight,
  }
}

/** Inverse of {@link normalizeRect} — denormalize a `[0,1]` rect back to frame-space pixels. */
export function denormalizeRect(
  rect: NormBbox,
  frameWidth: number,
  frameHeight: number,
): PixelRect {
  return {
    x: rect.x * frameWidth,
    y: rect.y * frameHeight,
    w: rect.w * frameWidth,
    h: rect.h * frameHeight,
  }
}

/**
 * Walk `steps` (the attach config's tree) collecting every ENABLED step
 * whose catalog definition's `inputClasses` includes `parentClassName` —
 * these become the subtree's roots. A matched step's own nested `children`
 * ride along UNCHANGED here (transitively included: `face-detection` pulls
 * `face-embedding`, `plate-detection` pulls `plate-ocr`) — recursion stops
 * at a match rather than also searching inside it for further matches.
 * `filter`, when given, keeps only the TOP-LEVEL matches whose `addonId` is
 * in the list — it does NOT prune a match's descendants. Strict per-`steps`
 * pruning of the descendant chain happens later in {@link runDetailSubtree}
 * (see {@link pruneChildStepsToRequested}); this function only selects roots.
 */
export function findMatchingDetailSteps(
  steps: readonly PipelineStepInputOutput[],
  parentClassName: string,
  lookupStepDefinition: (stepId: string) => StepClassDefinition | null,
  filter?: readonly string[],
): readonly PipelineStepInputOutput[] {
  const matches: PipelineStepInputOutput[] = []

  const walk = (list: readonly PipelineStepInputOutput[]): void => {
    for (const step of list) {
      if (!step.enabled) continue
      const definition = lookupStepDefinition(step.addonId)
      const isMatch =
        definition !== null &&
        definition.inputClasses !== null &&
        definition.inputClasses.includes(parentClassName)
      if (isMatch) {
        if (!filter || filter.includes(step.addonId)) matches.push(step)
        continue
      }
      if (step.children) walk(step.children)
    }
  }

  walk(steps)
  return matches
}

/**
 * Prune a matched step's descendant tree to the caller's requested `steps`
 * set: keep a child ONLY when its `addonId` is in `requested`, recursing into
 * every kept child. Pure — returns a new step, never mutates the input.
 *
 * Applied ONLY on the DETAIL plane (see {@link runDetailSubtree}); the
 * per-frame executor path is untouched. This is what makes the dispatcher's
 * `steps` array authoritative: `['face-detection']` runs the detector geometry
 * ALONE (the `face-embedding` child is dropped — no ArcFace inference), while
 * `['face-detection','face-embedding']` keeps the child and reproduces the
 * full detect→embed chain exactly.
 */
export function pruneChildStepsToRequested(
  step: PipelineStepInputOutput,
  requested: readonly string[],
): PipelineStepInputOutput {
  if (!step.children || step.children.length === 0) return step
  const children = step.children
    .filter((child) => requested.includes(child.addonId))
    .map((child) => pruneChildStepsToRequested(child, requested))
  return { ...step, children }
}

/** Map a detection's CROP-pixel bbox back to FRAME-space pixels. */
function mapBboxToFrameSpace(
  bbox: ObjectDetection['bbox'],
  crop: Pick<CropSource, 'width' | 'height' | 'frameSpace'>,
): Rect {
  const scaleX = crop.frameSpace.w / crop.width
  const scaleY = crop.frameSpace.h / crop.height
  return {
    x: crop.frameSpace.x + bbox.x * scaleX,
    y: crop.frameSpace.y + bbox.y * scaleY,
    w: bbox.width * scaleX,
    h: bbox.height * scaleY,
  }
}

/**
 * Map the root's FRAME-space boxes (D730) into the crop's pixels — the inverse
 * of {@link mapBboxToFrameSpace} — clamped to the crop. A box with nothing left
 * inside the crop is dropped. `null` when no box survives.
 */
export function suppliedRootForCrop(
  supplied: NonNullable<RunDetailSubtreeInput['supplied']>,
  crop: Pick<CropSource, 'width' | 'height' | 'frameSpace'>,
): SuppliedRootOutput | null {
  const scaleX = crop.width / crop.frameSpace.w
  const scaleY = crop.height / crop.frameSpace.h
  const detections: SuppliedRootOutput['detections'][number][] = []
  for (const box of supplied.boxes) {
    const x1 = Math.max(0, (box.bbox.x - crop.frameSpace.x) * scaleX)
    const y1 = Math.max(0, (box.bbox.y - crop.frameSpace.y) * scaleY)
    const x2 = Math.min(crop.width, (box.bbox.x + box.bbox.w - crop.frameSpace.x) * scaleX)
    const y2 = Math.min(crop.height, (box.bbox.y + box.bbox.h - crop.frameSpace.y) * scaleY)
    if (x2 <= x1 || y2 <= y1) continue
    detections.push({ bbox: [x1, y1, x2, y2], score: box.score })
  }
  const [first, ...rest] = detections
  if (first === undefined) return null
  return { stepId: supplied.stepId, modelId: supplied.modelId, detections: [first, ...rest] }
}

/** Whether the root's box for this step is a location to refine in (a face). */
function refinesSuppliedStep(stepId: string): boolean {
  return (
    (stepId === 'plate-detection' || stepId === 'face-detection') &&
    CROP_SUPPLY_SOURCES[stepId].use === 'refine'
  )
}

/** Base64-encode a normalized float32 embedding vector. */
function encodeEmbeddingBase64(embedding: readonly number[]): string {
  return Buffer.from(Float32Array.from(embedding).buffer).toString('base64')
}

/**
 * First user-visible label — skips the opaque `embedding:*` marker (see
 * `result-assembler.ts`). Returns the WHOLE `ScoredLabel`, not its text: since
 * 4g the tier and the attribution the assembler stamped travel with it, and
 * dropping them here is what would force post-analysis to guess a tier.
 */
function pickLabel(detection: ObjectDetection): ScoredLabel | undefined {
  return detection.labels.find((l) => !l.label.startsWith('embedding:'))
}

/**
 * Turn one executor detection into the cap's `DetailResult`, reprojecting its
 * crop-space bbox back onto the frame the crop came from.
 *
 * Exported because the STATELESS step path (`stateless-step.ts`) produces the
 * same shape from the same executor output and must not grow its own mapping —
 * a second reprojection is a second set of coordinates, and the two would agree
 * right up until one of them changed.
 */
export function toDetailResult(
  detection: ObjectDetection,
  stepId: string,
  crop: Pick<CropSource, 'width' | 'height' | 'frameSpace'>,
): DetailResult {
  const label = pickLabel(detection)
  return {
    stepId,
    className: detection.macroClass,
    score: detection.score,
    bbox: mapBboxToFrameSpace(detection.bbox, crop),
    ...(detection.embedding !== undefined
      ? { embedding: encodeEmbeddingBase64(detection.embedding) }
      : {}),
    // The RAW vector's magnitude travels with the embedding — `embedding` above
    // is the UNIT form, so the quality signal is unrecoverable downstream.
    ...(detection.embeddingMagnitude !== undefined
      ? { embeddingMagnitude: detection.embeddingMagnitude }
      : {}),
    // The model that produced the vector travels WITH the vector, gated on the
    // vector's presence: an id without an embedding would let a consumer
    // believe a probe was measured in a feature space that never ran. Dropping
    // this line is what made the recognizer's same-model gate a tautology —
    // see `detail-embedding-model-id.spec.ts`.
    ...(detection.embedding !== undefined && detection.embeddingModelId !== undefined
      ? { embeddingModelId: detection.embeddingModelId }
      : {}),
    ...(label !== undefined
      ? {
          label: label.label,
          // The tier is copied verbatim from the step definition by the
          // assembler. Absent ⇒ the step declares none, and the persistence
          // write rule refuses the label rather than inferring one.
          ...(label.tier !== undefined ? { labelTier: label.tier } : {}),
          ...(label.modelId !== undefined ? { labelModelId: label.modelId } : {}),
        }
      : {}),
    ...(detection.faceAlignedCrop !== undefined
      ? { alignedCropJpeg: detection.faceAlignedCrop }
      : {}),
    // Native-scale face size travels with the detail — the mapped bbox above is
    // detection-frame px, useless for a min-face-size gate on high-downscale
    // cameras (2026-07-22 native-gate fix).
    ...(detection.nativeFaceShortSidePx !== undefined
      ? { nativeFaceShortSidePx: detection.nativeFaceShortSidePx }
      : {}),
    // Landmarks reproject exactly like the bbox (D644).
    ...(detection.landmarks !== undefined
      ? { landmarks: detection.landmarks.map((p) => mapPointToFrameSpace(p, crop)) }
      : {}),
  }
}

/** A crop-space point on the frame the crop was cut from — `mapBboxToFrameSpace`'s twin. */
interface FramePoint {
  readonly x: number
  readonly y: number
}

function mapPointToFrameSpace(
  point: FramePoint,
  crop: Pick<CropSource, 'width' | 'height' | 'frameSpace'>,
): FramePoint {
  return {
    x: crop.frameSpace.x + point.x * (crop.frameSpace.w / crop.width),
    y: crop.frameSpace.y + point.y * (crop.frameSpace.h / crop.height),
  }
}

/**
 * How a full-frame caller expresses the subject box.
 *
 * A discriminated union rather than "always pixels", because the two callers
 * genuinely know different things and converting on the wrong side is how a
 * crop lands on scenery:
 *
 * - `frame-pixels` — the live detail plane, whose parent bbox is already in the
 *   coordinates of the image it is sending.
 * - `normalized` — a caller shipping STORED pixels, whose box was measured on a
 *   downscaled analysis frame while the image is a native-resolution capture.
 *   Only the side that decodes the image knows its dimensions, so it
 *   denormalizes — here, once, next to the decode.
 */
export type FullFrameBbox =
  | { readonly kind: 'frame-pixels'; readonly rect: PixelRect }
  | { readonly kind: 'normalized'; readonly rect: NormBbox }

/**
 * Cut the crop out of a caller-supplied FULL FRAME, applying the one crop
 * convention. This is the branch that made the rebuild comparable with live
 * traffic: before it existed the only way to feed stored pixels in was a
 * pre-cut tile, so the caller decided the rectangle and every caller decided
 * differently.
 *
 * Exported so the STATELESS step path can reach `deriveDetailCropRect` through
 * this function rather than importing it — `scripts/check-clip-crop-single-owner.ts`
 * permits exactly one importer, and that is the enforcement of
 * [D52](../../../../docs/decisions/adr-0052.md). A second caller of the
 * derivation is a second cutter no matter how similar its arithmetic looks
 * today.
 */
export async function cutFromFullFrame(
  frameJpegBase64: string,
  bbox: FullFrameBbox,
  convention: DetailCropConvention,
): Promise<CropSource | null> {
  const sharp = await getSharp()
  const jpeg = Buffer.from(frameJpegBase64, 'base64')
  const image = sharp(jpeg)
  const meta = await image.metadata()
  const frameWidth = meta.width ?? 0
  const frameHeight = meta.height ?? 0
  if (frameWidth <= 0 || frameHeight <= 0) return null

  const pixelBbox =
    bbox.kind === 'frame-pixels' ? bbox.rect : denormalizeRect(bbox.rect, frameWidth, frameHeight)
  const rect = deriveDetailCropRect(pixelBbox, frameWidth, frameHeight, convention)
  // sharp extracts integer pixels; the frameSpace reported back is the ROUNDED
  // rect actually cut, so result bboxes reproject against what the model saw.
  const left = Math.max(0, Math.min(Math.round(rect.x), frameWidth - 1))
  const top = Math.max(0, Math.min(Math.round(rect.y), frameHeight - 1))
  const width = Math.max(1, Math.min(Math.round(rect.w), frameWidth - left))
  const height = Math.max(1, Math.min(Math.round(rect.h), frameHeight - top))

  const crop = await image.extract({ left, top, width, height }).jpeg({ quality: 90 }).toBuffer()
  return {
    jpeg: crop,
    width,
    height,
    frameSpace: { x: left, y: top, w: width, h: height },
    source: 'derived',
  }
}

/**
 * The outcome of walking the crop ladder: the pixels that won, plus — when the
 * native rung was tried and lost — the runner's own classification of why.
 * The reason survives even on a rung that later SUCCEEDS, because "the native
 * lease is missing on every dispatch" is exactly the condition that is invisible
 * once a lower rung starts covering for it.
 */
export interface CropResolution {
  readonly crop: CropSource | null
  readonly nativeMiss: NativeCropMiss | null
}

async function resolveCrop(
  deps: Pick<DetailSubtreeDeps, 'getNativeCrop'>,
  input: RunDetailSubtreeInput,
  convention: DetailCropConvention,
): Promise<CropResolution> {
  let nativeMiss: NativeCropMiss | null = null
  if (input.frameHandle) {
    const padded = deriveDetailCropRect(
      input.parent.bbox,
      input.frameHandle.width,
      input.frameHandle.height,
      convention,
    )
    const normalized = normalizeRect(padded, input.frameHandle.width, input.frameHandle.height)
    const native = await deps.getNativeCrop(input.deviceId, input.frameHandle, normalized)
    if (native !== null) {
      if (!isNativeCropMiss(native)) return { crop: { ...native, source: 'native' }, nativeMiss }
      nativeMiss = native
    }
  }
  if (input.frameJpeg) {
    // Rung 2 — the caller holds the FULL frame and the runner cuts it, so the
    // rectangle still comes from the one derivation (D52). The payload is a
    // COMPRESSED per-track enrichment fetch, not frame-rate traffic, which is
    // what keeps it inside D9/D18: at most one full frame per dispatched detail
    // request, and only after the native rung already missed.
    return {
      crop: await cutFromFullFrame(
        input.frameJpeg,
        { kind: 'frame-pixels', rect: input.parent.bbox },
        convention,
      ),
      nativeMiss,
    }
  }
  if (input.cropJpeg) {
    const jpeg = Buffer.from(input.cropJpeg, 'base64')
    const sharp = await getSharp()
    const meta = await sharp(jpeg).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (width <= 0 || height <= 0) return { crop: null, nativeMiss }
    return {
      crop: {
        jpeg,
        width,
        height,
        // No frame dims available on the PRE-CUT path — the caller's crop is
        // trusted to already cover (an unknown padding of) the parent bbox, so
        // the parent's own unpadded frame-space rect is the best-effort mapping
        // anchor (never worse than reporting no bbox at all).
        frameSpace: input.parent.bbox,
        source: 'fallback',
      },
      nativeMiss,
    }
  }
  return { crop: null, nativeMiss }
}

/**
 * Run the DETAIL subtree for a single tracked detection: resolve a crop, run
 * each matched top-level child step's chain against it, and map every result
 * bbox back to frame space. Returns `null` when the camera isn't attached, no
 * configured child matches `input.parent.className`, or no crop source
 * resolves.
 *
 * ## The three pixel sources, in the order they are tried
 *
 * The distinction between them is not the pixels — it is WHICH SIDE derives the
 * rectangle, and conflating that is how one vector index came to hold two
 * feature spaces ([D52](../../../../docs/decisions/adr-0052.md)):
 *
 * 1. `frameHandle` — the node-local native lease. Cheapest when it hits (no
 *    payload crosses anything) and the only rung that yields a `nativeCropRef`,
 *    so leaf children re-cut their ROI at native resolution. **The runner cuts.**
 * 2. `frameJpeg` — a FULL frame the caller still holds. **The runner cuts**, with
 *    the same `deriveDetailCropRect` and the same convention, so the rectangle is
 *    identical to what rung 1 would have asked for. Reached when the lease has
 *    already expired — which, for the live detail plane, is the common case: the
 *    dispatcher's tick plus a 500–900 ms inference routinely outlives a 1.2 s
 *    lease, and before this rung was wired the step was simply abandoned.
 * 3. `cropJpeg` — an ALREADY-CUT tile, used verbatim, no padding and no squaring.
 *    **The caller decided the rectangle**, so it is outside the single-derivation
 *    guarantee and is only for the lease-miss retry.
 *
 * A rung-1 miss is remembered even when a lower rung succeeds, and travels into
 * the drop line below: "the native lease never hits any more" is precisely the
 * condition that goes invisible once something else covers for it.
 *
 * STRICT `steps` semantics: when the caller names an explicit `input.steps`
 * set, each matched root's descendant chain is pruned to exactly those ids
 * (see {@link pruneChildStepsToRequested}) — `resolveChildSteps`/`filter`
 * only selects TOP-LEVEL roots, so without this a matched `face-detection`
 * would always drag its `face-embedding` child along regardless of what was
 * asked for. When `input.steps` is omitted, the full configured chain runs
 * (today's behavior). This is the knob the dispatcher uses to run a periodic
 * geometry-only face refresh (`['face-detection']`) without re-running ArcFace.
 */
export async function runDetailSubtree(
  deps: DetailSubtreeDeps,
  input: RunDetailSubtreeInput,
): Promise<DetailSubtreeOutcome | null> {
  const matched = deps.resolveChildSteps(input.deviceId, input.parent.className, input.steps)
  // Both of these used to be a bare `return null`, which reads identically to
  // "the call was never made" — the failure mode the rebuild cannot survive,
  // since a detached camera would silently contribute zero vectors while the
  // pass reported a clean run.
  if (!matched) {
    deps.logger.warn('runDetailSubtree: camera is not attached — no detail steps to run', {
      tags: { deviceId: input.deviceId },
      meta: {
        parentClass: input.parent.className,
        ...(input.steps ? { requestedSteps: [...input.steps] } : {}),
      },
    })
    // TYPED, not `null`: the caller must be able to tell "this camera has no
    // session" (stop the crop ladder) from "this dispatch found no pixels"
    // (a lower rung may still serve). See DetailNotAttachedRefusal.
    return { refusal: 'not-attached' }
  }
  if (matched.length === 0) {
    deps.logger.warn('runDetailSubtree: no matching detail step is enabled for this parent class', {
      tags: { deviceId: input.deviceId },
      meta: {
        parentClass: input.parent.className,
        ...(input.steps ? { requestedSteps: [...input.steps] } : {}),
        hint: 'the step is either absent from this camera step tree or disabled on it',
      },
    })
    return null
  }
  const requested = input.steps
  const steps =
    requested === undefined
      ? matched
      : matched.map((step) => pruneChildStepsToRequested(step, requested))

  // D730: a root face box is only a LOCATION — it is refined in its own
  // face-scoped square, never cut by the subject convention below.
  const supplied = input.supplied
  if (supplied !== undefined && refinesSuppliedStep(supplied.stepId)) {
    const details: DetailResult[] = []
    for (const step of matched) {
      if (step.addonId !== supplied.stepId) continue
      const placement = deps.placeStep?.(input.deviceId, step)
      const refined = await refineRootFace(
        deps,
        input,
        supplied,
        placement?.step ?? step,
        requested,
        placement?.deviceKey,
      )
      if (refined === null) return null
      details.push(...refined)
    }
    return { details }
  }

  const convention = deps.resolveCropConvention(input.deviceId)
  const { crop, nativeMiss } = await resolveCrop(deps, input, convention)
  if (!crop) {
    deps.logger.warn('runDetailSubtree: no crop source resolved — the dispatch produced nothing', {
      tags: { deviceId: input.deviceId },
      meta: {
        parentClass: input.parent.className,
        hadFrameHandle: input.frameHandle !== undefined,
        hadFrameJpeg: input.frameJpeg !== undefined,
        hadCropJpeg: input.cropJpeg !== undefined,
        // The runner's own classification of the rung-1 failure. The caller's
        // half of this pair (its round-trip) is logged on the other side; both
        // are needed to tell "the window is too small" from "the ask was late".
        nativeMissReason: nativeMiss?.miss ?? null,
        nativeHandleAgeMs: nativeMiss?.handleAgeMs ?? null,
        // And the WORKER's half, which is the only one that separates "nothing
        // was retained for this frame" from "no tile contains this rectangle".
        // Those two have different fixes and shared one word until 2026-09-07.
        nativeWorkerReason: nativeMiss?.workerReason ?? null,
      },
    })
    // The registry's refusal is final for THIS handle — say so, typed, so the
    // caller retires it instead of re-asking every tick (D688).
    if (nativeMiss?.miss === 'handle-expired') {
      return { refusal: 'handle-expired', handleAgeMs: nativeMiss.handleAgeMs }
    }
    return null
  }

  // NATIVE child-crop path: when the parent crop was resolved from the frame's
  // native surface (a frameHandle HIT), pass a reference so the executor re-cuts
  // leaf child ROIs (plate-ocr, face-embedding, leaf classifiers) at native
  // resolution — the SAME surface, the small ROI, no downscale. On the fallback
  // (downscaled tile) path there is no live native reference, so children stay on
  // the tile (today's behaviour).
  const nativeCropRef: NativeCropRef | undefined =
    input.frameHandle !== undefined && crop.source === 'native'
      ? { handle: input.frameHandle, cropFrameSpace: crop.frameSpace }
      : undefined

  const details: DetailResult[] = []
  let unjudgedFaces = 0
  for (const step of steps) {
    // Step-tree device jump: which same-node device runs THIS enrichment
    // subtree (its inherited children ride the same call → same device), and
    // the step as it must run there (a jumped subtree carries the target's
    // provisioning, D650). Absent placer ⇒ the runner's per-camera default.
    const placement = deps.placeStep?.(input.deviceId, step)
    // D730: the root drew this step's boxes — the step is not inferred, its
    // children read the root's boxes instead.
    const suppliedRoot =
      input.supplied !== undefined && input.supplied.stepId === step.addonId
        ? suppliedRootForCrop(input.supplied, crop)
        : undefined
    if (suppliedRoot === null) {
      deps.logger.warn(
        'runDetailSubtree: the root-supplied boxes fall outside the crop — nothing to read',
        {
          tags: { deviceId: input.deviceId },
          meta: { stepId: step.addonId, parentClass: input.parent.className },
        },
      )
      continue
    }
    const result = await deps.runPipeline(
      [placement?.step ?? step],
      crop.jpeg,
      input.deviceId,
      placement?.deviceKey,
      nativeCropRef,
      // Only a supplied step carries the sixth argument.
      ...(suppliedRoot !== undefined ? [suppliedRoot] : []),
    )
    if (!result) continue
    for (const detection of result.detections) {
      const detail = toDetailResult(detection, step.addonId, crop)
      // D662: the crop is PADDED, so the detector also saw the margin around
      // the person; a face whose centre is outside the UNPADDED person box was
      // found there (a wheel, on 102) and is not this person's face. A detail
      // with no box has no geometry to judge and passes.
      if (detail.className === FACE_CLASS && crop.source === 'fallback') {
        unjudgedFaces += 1
      } else if (
        detail.className === FACE_CLASS &&
        detail.bbox !== undefined &&
        !faceCentreInsideParent(detail.bbox, input.parent.bbox)
      ) {
        announceFaceOutsideParent(deps, {
          deviceId: input.deviceId,
          score: detail.score,
          faceBbox: detail.bbox,
          parentBbox: input.parent.bbox,
        })
        continue
      }
      details.push(detail)
    }
  }
  if (unjudgedFaces > 0) {
    // D391: the pre-cut rung's mapping anchor IS the parent box, so the guard
    // would be vacuous; the faces pass, and the line says they were not judged.
    deps.logger.warn(FACE_GUARD_UNAVAILABLE_MESSAGE, {
      tags: { deviceId: input.deviceId },
      meta: { faces: unjudgedFaces, cropSource: crop.source },
    })
  }
  return { details }
}

function announceFaceOutsideParent(deps: DetailSubtreeDeps, drop: FaceOutsideParentDrop): void {
  if (deps.recordFaceOutsideParent !== undefined) {
    deps.recordFaceOutsideParent(drop)
    return
  }
  deps.logger.warn(FACE_OUTSIDE_PARENT_MESSAGE, {
    tags: { deviceId: drop.deviceId },
    meta: faceOutsideParentMeta(drop),
  })
}
