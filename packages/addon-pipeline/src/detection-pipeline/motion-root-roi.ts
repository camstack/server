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
 * cropping and the full frame runs, exactly as before. A forced full frame
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
  NormalizedRect,
  RootInputSource,
  RootInputSourceReason,
} from '@camstack/types'

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

/** A pixel rectangle in frame space. */
export interface RoiPixelRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

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
  | { readonly source: 'roi'; readonly crop: RoiPixelRect }
  | { readonly source: 'full'; readonly reason: Exclude<RootInputSourceReason, 'motion'> }

function unionPx(rects: readonly NormalizedRect[], fw: number, fh: number): RoiPixelRect | null {
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
): RoiPixelRect {
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
  return { source: 'roi', crop }
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

export interface RoiDecideInput {
  readonly deviceId: number
  readonly now: number
  readonly motion: readonly NormalizedRect[]
  readonly frame: { readonly width: number; readonly height: number }
  readonly modelInput: { readonly width: number; readonly height: number }
}

/**
 * Per-camera state around {@link planMotionRootRoi}: the forced-full cadence
 * and the recent root boxes. One instance per detection-pipeline provider.
 */
export class MotionRootRoiGovernor {
  private readonly lastFullAt = new Map<number, number>()
  private readonly liveBoxes = new Map<number, LiveBoxEntry>()

  decide(input: RoiDecideInput): RootInputSource {
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

  /** The root's first-level boxes on a frame it just ran, normalised. An empty list replaces the previous one. */
  noteBoxes(deviceId: number, boxes: readonly NormalizedRect[], now: number): void {
    this.liveBoxes.set(deviceId, { at: now, boxes })
  }

  forget(deviceId: number): void {
    this.lastFullAt.delete(deviceId)
    this.liveBoxes.delete(deviceId)
  }
}
