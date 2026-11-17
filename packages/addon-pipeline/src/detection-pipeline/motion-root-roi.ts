/**
 * Motion-guided root crop (D1060) — the ONE derivation of the rectangle the
 * object-detection ROOT runs on, per frame.
 *
 * The root detector used to see the whole frame letterboxed to its input. A
 * subject that is small relative to the frame (high resolution, far subject,
 * high mounting) arrives at the model as a few dozen pixels and scores under
 * the floor. This module picks, per frame, between the full frame and a crop
 * around where things are moving, at the SAME inference count: the crop
 * replaces the full frame, it is never a second pass (contrast D396, which
 * adds one).
 *
 * The ROI is the union of the analyzer's merged motion subjects (D394) and the
 * boxes the root reported on its recent frames, plus a margin, expanded to the
 * model's aspect, never smaller than a floor that keeps subjects small enough
 * for the model, and clamped inside the frame. Above a ceiling it is not worth
 * cropping and the full frame runs, exactly as before. A subject the root
 * already saw large is never magnified: when its recent box would exceed
 * {@link MAX_SUBJECT_INPUT_PX} in the model input once cropped, the full frame
 * runs (`subject-too-large`). A crop that found nothing where the root had
 * boxes keeps those boxes and hands the next frame to the full frame
 * (`roi-missed`), so a subject that grew past the crop is not locked out. A
 * shed root (no inference ran) changes nothing. A forced full frame
 * about once a second keeps entries outside the motion area and the parked
 * subjects (D683) in view.
 *
 * What this is NOT (D52): not a detail/CLIP crop. `deriveDetailCropRect`
 * derives the crop an enrichment step sees from a KNOWN subject; this derives
 * the first-level detector's input before any subject exists. Its output is
 * detections re-projected to frame space, never a vector. Neither may be used
 * for the other.
 *
 * The geometry is pure; the per-camera state (cadence, recent boxes) lives in
 * `MotionRootRoiGovernor`, owned by the detection-pipeline provider.
 */
import type {
  FrameResult,
  FrameViewCrop,
  NormalizedRect,
  PipelineExecutionPlane,
  RootInputSource,
  RootInputSourceReason,
} from '@camstack/types'
import type { ExecutableStep } from './pipeline/tree-builder.js'

/**
 * The root the motion ROI drives. Its floor ({@link ROI_MIN_FRAME_FRACTION},
 * {@link ROI_MIN_DOWNSCALE}) was measured on the object-detection model; any
 * other root would need its own scale sweep before it may be cropped here.
 */
export const MOTION_ROI_ROOT_STEP_ID = 'object-detection'

/**
 * Context margin added on every side of the union, as a fraction of the
 * union's long side. Replay setting (2026-11-17).
 */
export const ROI_MARGIN_FRACTION = 0.15

/**
 * Minimum ROI long side, as a fraction of the frame's long side.
 *
 * Replay evidence (2026-11-17, camera 1441, int8 YOLOv8m on CPU OpenVINO):
 * this model scores LARGE subjects badly. A person about 300 px tall in the
 * 640 input scored 0.09; the same person at about 75 px scored 0.65. A
 * 640-px minimum side (a native 1:1 crop) made the camera WORSE (one passage
 * fell from 9 hits to 2 and lost its birth); 1280 or 1888 px recovered two
 * passages that had no birth and gave a third 6x more hits at or above 0.55.
 * The model wants subjects of roughly 40-150 px in its input. Model-dependent:
 * a new root model needs a new scale sweep.
 */
export const ROI_MIN_FRAME_FRACTION = 0.45

/**
 * The ROI is downscaled at least this many times into the model input, so a
 * native 1:1 crop never happens — the same replay evidence as
 * {@link ROI_MIN_FRAME_FRACTION}, stated against the model instead of the
 * frame. The larger of the two floors wins.
 */
export const ROI_MIN_DOWNSCALE = 2

/**
 * Above this fraction of the frame's long side the crop magnifies too little
 * to be worth it; the full frame runs, as before D1060.
 */
export const ROI_MAX_FRAME_FRACTION = 0.6

/**
 * A full frame replaces one ROI frame at least this often, per camera, so an
 * entry outside the motion area and a still subject (parked-object registry,
 * D683) are still seen. Costs no inference: it replaces a crop. ~1/s is the
 * replay's setting; it was not measured.
 */
export const ROI_FORCED_FULL_INTERVAL_MS = 1_000

/**
 * How long the root's own boxes keep a place in the ROI after the frame that
 * produced them. They stand in for the live tracks (the tracker runs in
 * another process); a still subject must not fall out of the crop the moment
 * the motion stops.
 */
export const ROI_LIVE_BOX_MAX_AGE_MS = 2_000

/**
 * The largest subject, long side in MODEL-INPUT pixels, the ROI may hand the
 * root. Same replay evidence as {@link ROI_MIN_FRAME_FRACTION}: the int8 model
 * wants subjects of roughly 40-150 px in its input and scored a ~300 px person
 * at 0.09. Measured on the root's own recent boxes once the crop is scaled
 * into the input; above it the full frame runs (`subject-too-large`).
 */
export const MAX_SUBJECT_INPUT_PX = 150

/**
 * A camera whose frames stopped this long ago is forgotten by the governor.
 * The detection-pipeline provider has no per-camera teardown (a camera that
 * leaves simply stops sending frames), so the governor bounds its own state.
 * A camera that comes back starts with a forced full frame, as on first sight.
 */
export const ROI_IDLE_FORGET_MS = 60_000

export interface RoiPlanInput {
  /** Merged motion subjects (D394), normalised to the frame. */
  readonly motion: readonly NormalizedRect[]
  /** Recent root boxes, normalised to the frame. */
  readonly liveBoxes: readonly NormalizedRect[]
  readonly frame: { readonly width: number; readonly height: number }
  /** The root model's input size — the ROI takes its aspect. */
  readonly modelInput: { readonly width: number; readonly height: number }
}

export type RoiPlan =
  | { readonly source: 'roi'; readonly crop: FrameViewCrop }
  | {
      readonly source: 'full'
      readonly reason: Exclude<RootInputSourceReason, 'motion' | 'forced-full' | 'roi-missed'>
    }

function unionPx(rects: readonly NormalizedRect[], fw: number, fh: number): FrameViewCrop | null {
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    if (!(r.w > 0 && r.h > 0)) continue
    x1 = Math.min(x1, r.x * fw)
    y1 = Math.min(y1, r.y * fh)
    x2 = Math.max(x2, (r.x + r.w) * fw)
    y2 = Math.max(y2, (r.y + r.h) * fh)
  }
  if (!Number.isFinite(x1) || x2 <= x1 || y2 <= y1) return null
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
}

/** Place a `w`×`h` box centred on (cx, cy) inside the frame, shifting rather than cutting. */
function placeInside(
  cx: number,
  cy: number,
  w: number,
  h: number,
  fw: number,
  fh: number,
): FrameViewCrop {
  const width = Math.min(w, fw)
  const height = Math.min(h, fh)
  const left = Math.min(Math.max(0, cx - width / 2), fw - width)
  const top = Math.min(Math.max(0, cy - height / 2), fh - height)
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * The pure geometry: full frame or which crop, for one frame. No cadence here —
 * the forced full frame is the governor's.
 */
export function planMotionRootRoi(input: RoiPlanInput): RoiPlan {
  const fw = input.frame.width
  const fh = input.frame.height
  const mw = input.modelInput.width
  const mh = input.modelInput.height
  if (!(fw > 0 && fh > 0 && mw > 0 && mh > 0)) return { source: 'full', reason: 'no-geometry' }
  const union = unionPx([...input.motion, ...input.liveBoxes], fw, fh)
  if (union === null) return { source: 'full', reason: 'no-motion' }

  const pad = ROI_MARGIN_FRACTION * Math.max(union.width, union.height)
  let w = union.width + 2 * pad
  let h = union.height + 2 * pad
  const aspect = mw / mh
  if (w / h < aspect) w = h * aspect
  else h = w / aspect

  const frameLong = Math.max(fw, fh)
  const minLong = Math.max(ROI_MIN_FRAME_FRACTION * frameLong, ROI_MIN_DOWNSCALE * Math.max(mw, mh))
  const long = Math.max(w, h)
  if (long < minLong) {
    const grow = minLong / long
    w *= grow
    h *= grow
  }

  const cx = union.left + union.width / 2
  const cy = union.top + union.height / 2
  const crop = placeInside(cx, cy, w, h, fw, fh)
  if (Math.max(crop.width, crop.height) > ROI_MAX_FRAME_FRACTION * frameLong) {
    return { source: 'full', reason: 'roi-too-large' }
  }
  if (largestSubjectInputPx(input.liveBoxes, crop, fw, fh, mw, mh) > MAX_SUBJECT_INPUT_PX) {
    return { source: 'full', reason: 'subject-too-large' }
  }
  return { source: 'roi', crop }
}

/**
 * The long side, in model-input pixels, of the largest root box once `crop` is
 * letterboxed into the model input. Only the root's own boxes count: a motion
 * blob is not a subject the model sized.
 */
function largestSubjectInputPx(
  boxes: readonly NormalizedRect[],
  crop: FrameViewCrop,
  fw: number,
  fh: number,
  mw: number,
  mh: number,
): number {
  const scale = Math.min(mw / crop.width, mh / crop.height)
  let largest = 0
  for (const b of boxes) largest = Math.max(largest, b.w * fw, b.h * fh)
  return largest * scale
}

/** A frame result's first-level boxes, normalised to its frame — the governor's live boxes. */
export function normalizedFirstLevelBoxes(result: FrameResult): readonly NormalizedRect[] {
  if (!(result.width > 0 && result.height > 0)) return []
  return result.detections
    .filter((d) => d.kind === 'first-level')
    .map((d) => ({
      x: d.bbox.x / result.width,
      y: d.bbox.y / result.height,
      w: d.bbox.width / result.width,
      h: d.bbox.height / result.height,
    }))
}

interface LiveBoxEntry {
  readonly at: number
  readonly boxes: readonly NormalizedRect[]
}

/** What one root run left behind, as the governor needs it. */
export interface RootRun {
  /** The pixels the root was asked to run on. */
  readonly source: RootInputSource['source']
  /** The pool shed the root: no inference ran, the empty box list means nothing. */
  readonly shed: boolean
  /** The root's first-level boxes, normalised to the frame. */
  readonly boxes: readonly NormalizedRect[]
}

/** The {@link RootRun} of a frame the root ran under `decision`. */
export function rootRunOf(decision: RootInputSource, result: FrameResult): RootRun {
  return {
    source: decision.source,
    shed: result.shed === true,
    boxes: normalizedFirstLevelBoxes(result),
  }
}

/** The root candidate the motion ROI may drive, and the run it is asked about. */
export interface MotionRoiEligibility {
  /** A live frame reference the root can cut a view from. */
  readonly hasFrameRef: boolean
  readonly plane: PipelineExecutionPlane | undefined
  readonly replay: boolean
  readonly hasSuppliedRoot: boolean
  readonly deviceId: number
  readonly roots: readonly ExecutableStep[]
}

/**
 * The input size of the root the motion ROI drives on this run, or `undefined`
 * when the run keeps the full frame: only a live `frame`-plane run with a
 * frame reference, on a camera, with no supplied root, and never a replay or a
 * `crop-zone` root.
 */
export function motionRoiModelInput(
  run: MotionRoiEligibility,
): { readonly width: number; readonly height: number } | undefined {
  if (!run.hasFrameRef || run.plane !== 'frame' || run.replay || run.hasSuppliedRoot) {
    return undefined
  }
  if (!(run.deviceId > 0)) return undefined
  const root = run.roots.find(
    (r) => r.stepId === MOTION_ROI_ROOT_STEP_ID && r.definition.extractMode !== 'crop-zone',
  )
  return root?.definition.models.find((m) => m.id === root.modelId)?.inputSize
}

/** The trace with the root input decision stamped on it (D1060). */
export function withRootSource<T extends object>(
  trace: T | null | undefined,
  decision: RootInputSource | undefined,
): T | null | undefined {
  if (trace == null || decision === undefined) return trace
  return { ...trace, rootSource: decision }
}

export interface RoiDecideInput {
  readonly deviceId: number
  readonly now: number
  readonly motion: readonly NormalizedRect[]
  readonly frame: { readonly width: number; readonly height: number }
  readonly modelInput: { readonly width: number; readonly height: number }
}

/**
 * Per-camera state around {@link planMotionRootRoi}: the forced-full cadence,
 * the recent root boxes and a pending crop miss. One instance per
 * detection-pipeline provider; an idle camera is forgotten after
 * {@link ROI_IDLE_FORGET_MS}.
 */
export class MotionRootRoiGovernor {
  private readonly lastFullAt = new Map<number, number>()
  private readonly liveBoxes = new Map<number, LiveBoxEntry>()
  private readonly lastSeenAt = new Map<number, number>()
  private readonly roiMissed = new Set<number>()
  private lastSweepAt = 0

  decide(input: RoiDecideInput): RootInputSource {
    this.sweepIdle(input.now)
    this.lastSeenAt.set(input.deviceId, input.now)
    if (this.roiMissed.delete(input.deviceId)) {
      this.lastFullAt.set(input.deviceId, input.now)
      return { stepId: MOTION_ROI_ROOT_STEP_ID, source: 'full', reason: 'roi-missed' }
    }
    const last = this.lastFullAt.get(input.deviceId)
    if (last === undefined || input.now - last >= ROI_FORCED_FULL_INTERVAL_MS) {
      this.lastFullAt.set(input.deviceId, input.now)
      return { stepId: MOTION_ROI_ROOT_STEP_ID, source: 'full', reason: 'forced-full' }
    }
    const entry = this.liveBoxes.get(input.deviceId)
    const boxes =
      entry !== undefined && input.now - entry.at <= ROI_LIVE_BOX_MAX_AGE_MS ? entry.boxes : []
    const plan = planMotionRootRoi({
      motion: input.motion,
      liveBoxes: boxes,
      frame: input.frame,
      modelInput: input.modelInput,
    })
    if (plan.source === 'roi') {
      return { stepId: MOTION_ROI_ROOT_STEP_ID, source: 'roi', reason: 'motion', crop: plan.crop }
    }
    this.lastFullAt.set(input.deviceId, input.now)
    return { stepId: MOTION_ROI_ROOT_STEP_ID, source: 'full', reason: plan.reason }
  }

  /**
   * What the root's run on a frame left behind. A shed root changes nothing.
   * Boxes replace the previous ones; an empty full frame clears them. An empty
   * CROP where the root had recent boxes keeps them (they age out on their
   * own) and sends the next frame to the full frame: the subject may have
   * grown past what the crop can score.
   */
  noteRootRun(deviceId: number, run: RootRun, now: number): void {
    if (run.shed) return
    if (run.boxes.length === 0 && run.source === 'roi') {
      const entry = this.liveBoxes.get(deviceId)
      if (
        entry !== undefined &&
        entry.boxes.length > 0 &&
        now - entry.at <= ROI_LIVE_BOX_MAX_AGE_MS
      ) {
        this.roiMissed.add(deviceId)
        return
      }
    }
    this.liveBoxes.set(deviceId, { at: now, boxes: run.boxes })
  }

  forget(deviceId: number): void {
    this.lastFullAt.delete(deviceId)
    this.liveBoxes.delete(deviceId)
    this.lastSeenAt.delete(deviceId)
    this.roiMissed.delete(deviceId)
  }

  /** How many cameras the governor holds state for. */
  trackedCameraCount(): number {
    return this.lastSeenAt.size
  }

  private sweepIdle(now: number): void {
    if (now - this.lastSweepAt < ROI_IDLE_FORGET_MS) return
    this.lastSweepAt = now
    for (const [deviceId, seenAt] of this.lastSeenAt) {
      if (now - seenAt > ROI_IDLE_FORGET_MS) this.forget(deviceId)
    }
  }
}
