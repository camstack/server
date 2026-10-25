/**
 * Small-subject recovery — a second detector pass at NATIVE resolution on
 * the moving regions the full-frame pass did not account for.
 *
 * ## Why
 *
 * The first-level detector sees the frame at its input size (320 px on every
 * hardware-aware default). A 4K frame is reduced 12×: a dog measured at
 * 89–277 px in the source is 7–38 px for the model and is not emitted. Camera 101, six
 * instants with a dog in the scene, five with no `animal` detection at all —
 * nothing downstream (tracker, gate, notifications) ever saw a subject. The
 * confirmation gate, which re-runs the same detector on a 320 px native crop
 * of the PERSON, found the dog at 0.74–0.91 as `bestIncompatibleClass`. The
 * measurement that decided the constants below is
 * `docs/benchmarks/pipeline-frame-model-eval.md`, case `miss-dog-101`: a
 * 640–800 px native square around the moving region brings the dog to
 * 0.82–0.91 with the SAME 320 model; a 1280 px square loses it again.
 *
 * ## What this is NOT (D52)
 *
 * Not a detail/CLIP crop. `deriveDetailCropRect` derives the rectangle a
 * detail or embedding step is fed from a KNOWN subject box, and one vector
 * index tolerates exactly one such derivation. This module derives a square
 * from a MOTION region, before any subject exists, for the FIRST-LEVEL
 * detector; its output is a detection, never a vector. Nothing here may be
 * reused for a detail crop, and nothing here calls the detail derivation.
 *
 * ## When it runs — NOT only when the frame is empty
 *
 * The trigger is an UNCOVERED MOTION REGION, deliberately broader than "the
 * full-frame pass found nothing". Camera 101, 2026-09-06 19:54:33 local: the
 * gate DID confirm an `animal` birth (bestScore 0.8983) — and the track held
 * 9 positions over 1 666 ms, then coasted out its `maxMissedMs` (4 000 ms) and
 * died at 19:54:39, before the dog reached the Aiuola zone. Both of its object
 * events carry `zones: []`, while in the same seconds the animal was in fact
 * at x≈3200, inside the zone. So the defect is not only "the subject is never
 * born" — it is "the subject is born and then the full-frame pass stops seeing
 * it", and a pass gated on "no detections at all" would not have run on a
 * single one of those frames, because the PERSON was still detected.
 *
 * Gating on the motion region instead makes the pass fire in both cases with
 * one rule: a moving thing the full-frame boxes do not account for. A live
 * track feeding on recovered boxes needs one hit per `maxMissedMs` to survive
 * and `minHits` (3) to be born; at {@link RECOVERY_MIN_INTERVAL_MS} the pass
 * supplies 2/s, which is 8× the coasting budget and births a subject in 1.5 s.
 *
 * ## Where
 *
 * In the runner, in-process, on the frame the full pass just ran on. The
 * pixels come from the same process-local `frameRef` lease the full pass
 * used; the crop is resolved as one compressed ≤640 px view. Frames never
 * cross a process boundary at frame rate (D9/D18) — a second crop of the
 * same frame on the same channel does not change that.
 *
 * Pure: no runner state, no IPC, no pixels. The runner wires the lease, the
 * executor call and the rate limit around it.
 *
 * Lives in `@camstack/types` so the live runner (`addon-pipeline`) and the
 * offline accuracy evaluation (`addon-benchmark`) plan the SAME crops: one
 * module, two callers, no copy to drift.
 */
import type { ObjectDetection } from '../../types/detection.js'
import type { PipelineStepInputOutput } from '../../capabilities/pipeline-executor.cap.js'

/** The object-detection step id — the first-level detector both recipes run. */
export const OBJECT_DETECTION_STEP_ID = 'object-detection'

/** Fraction of a frame, `[0, 1]` on both axes. */
export interface NormalizedRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface FrameDims {
  readonly width: number
  readonly height: number
}

/** A square of the NATIVE frame, in native pixels. */
export interface RecoveryCrop {
  readonly left: number
  readonly top: number
  readonly side: number
}

/**
 * Smallest crop side, native pixels. Below this the model no longer
 * magnifies enough to matter on a 4K frame, and on a 1080p frame 640 is
 * already a third of the picture. Measured: 480–800 px all recover the dog.
 */
export const RECOVERY_CROP_MIN_SIDE_PX = 640
/**
 * Largest crop side. A 320 model on a 1024 px square is a 3.2× reduction and
 * scored the dog at 0.52–0.76; at 1280 px it was absent again. A region wider
 * than this is tiled, never zoomed out.
 */
export const RECOVERY_CROP_MAX_SIDE_PX = 800
/** Context around the region before squaring, as a fraction of its larger side. */
export const RECOVERY_CROP_PADDING_RATIO = 0.25
/**
 * The view the crop is resolved at, compressed. Never larger than the crop
 * (the floor is {@link RECOVERY_CROP_MIN_SIDE_PX}), so it never upscales, and
 * the model letterboxes it to its own input from here as it does the frame.
 */
export const RECOVERY_VIEW_PX = 640
/**
 * Crops per frame. Each is one more inference on the same pool (15–25 ms on
 * CoreML for a 640 view); two cover a person-and-dog blob and a second mover.
 */
export const RECOVERY_MAX_CROPS_PER_FRAME = 2
/**
 * The pass runs at most this often per camera — at 10 fps that is one frame
 * in five. A subject the full pass misses is missed for seconds, not for one
 * frame, so the recovery does not need every frame to find it.
 *
 * The floor under this number is the tracker: a track coasts for
 * `maxMissedMs` (4 000 ms by default) before it is dropped, so 2 recoveries a
 * second keep a subject the full-frame pass has lost ALIVE with 8× margin,
 * and reach `minHits` (3) in 1.5 s. Raising it past ~1 300 ms would start to
 * lose tracks between passes.
 */
export const RECOVERY_MIN_INTERVAL_MS = 500
/**
 * A region larger than this share of the frame is not a small subject: a
 * lighting change, a car filling the picture, a person at the lens. The
 * full-frame pass already sees those at scale.
 */
export const RECOVERY_MAX_REGION_FRAME_FRACTION = 0.25
/**
 * How much of a region must lie OUTSIDE every full-frame detection for the
 * pass to run on it. A person's own blob (dilated, with shadow) is covered
 * 70–90% by the person box; a person-and-dog blob is covered ~55% by it.
 */
export const RECOVERY_MIN_UNCOVERED_FRACTION = 0.35
/** Motion regions older than this describe a different frame. */
export const RECOVERY_MOTION_MAX_AGE_MS = 2_000
/** A recovered box overlapping a same-class full-frame box this much is the same subject. */
export const RECOVERY_FUSE_IOU = 0.5
/**
 * A recovered box CONTAINED this much in a same-class full-frame box is a part
 * of it — a torso the crop cut out of a person the full pass already has.
 */
export const RECOVERY_FUSE_CONTAINMENT = 0.7
/** A box within this many crop-view pixels of the crop edge was clipped by it. */
export const RECOVERY_EDGE_MARGIN_PX = 2

/** Area of a normalised rectangle, never negative. Shared with the D396 recipe. */
export function normalizedArea(r: NormalizedRect): number {
  return Math.max(0, r.w) * Math.max(0, r.h)
}

const area = normalizedArea

function intersection(a: NormalizedRect, b: NormalizedRect): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return w * h
}

/**
 * Share of `region` not covered by any detection box. The sum of pairwise
 * intersections over-counts where detections overlap each other, which only
 * makes the pass MORE conservative; clipped at 1.
 */
function uncoveredFraction(region: NormalizedRect, detections: readonly NormalizedRect[]): number {
  const regionArea = area(region)
  if (regionArea <= 0) return 0
  let covered = 0
  for (const detection of detections) covered += intersection(region, detection)
  return 1 - Math.min(1, covered / regionArea)
}

/**
 * THE square-placement rule of this pass — one owner, shared by both recipes.
 *
 * A crop is a square of `side` native pixels centred where it can be and slid
 * inside the frame where it cannot. Both region rules place their squares
 * through this function so a crop means the same rectangle whichever rule
 * chose the region.
 */
export function squareAround(
  centreX: number,
  centreY: number,
  side: number,
  native: FrameDims,
): RecoveryCrop {
  const left = Math.round(Math.max(0, Math.min(native.width - side, centreX - side / 2)))
  const top = Math.round(Math.max(0, Math.min(native.height - side, centreY - side / 2)))
  return { left, top, side }
}

function contains(crop: RecoveryCrop, x: number, y: number): boolean {
  return x >= crop.left && x <= crop.left + crop.side && y >= crop.top && y <= crop.top + crop.side
}

/**
 * Squares for one region: one when it fits the largest side, otherwise up to
 * two tiles along its longer axis (a person-sized blob with something small
 * at either end). The padded region decides the side, never the frame.
 */
function cropsForRegion(region: NormalizedRect, native: FrameDims): readonly RecoveryCrop[] {
  const widthPx = region.w * native.width
  const heightPx = region.h * native.height
  const longest = Math.max(widthPx, heightPx)
  const padded = longest * (1 + 2 * RECOVERY_CROP_PADDING_RATIO)
  const side = Math.round(
    Math.min(Math.max(padded, RECOVERY_CROP_MIN_SIDE_PX), RECOVERY_CROP_MAX_SIDE_PX),
  )
  const centreX = (region.x + region.w / 2) * native.width
  const centreY = (region.y + region.h / 2) * native.height
  if (padded <= RECOVERY_CROP_MAX_SIDE_PX) return [squareAround(centreX, centreY, side, native)]
  const alongX = widthPx >= heightPx
  const quarter = longest / 4
  return [
    squareAround(
      alongX ? centreX - quarter : centreX,
      alongX ? centreY : centreY - quarter,
      side,
      native,
    ),
    squareAround(
      alongX ? centreX + quarter : centreX,
      alongX ? centreY : centreY + quarter,
      side,
      native,
    ),
  ]
}

export interface RecoveryPlanInput {
  /** Motion regions of this frame, normalised. */
  readonly regions: readonly NormalizedRect[]
  /** The full-frame pass's boxes, normalised. */
  readonly detections: readonly NormalizedRect[]
  /** The NATIVE frame the crops are cut from. */
  readonly native: FrameDims
}

/**
 * The crops the second pass runs on this frame — possibly none.
 *
 * A region qualifies when it is small (`RECOVERY_MAX_REGION_FRAME_FRACTION`)
 * and mostly uncovered by the full-frame boxes
 * (`RECOVERY_MIN_UNCOVERED_FRACTION`). Qualifying regions are served largest
 * uncovered area first under `RECOVERY_MAX_CROPS_PER_FRAME`; a crop whose
 * centre already lies inside a planned crop is folded into it. A frame that
 * cannot hold the smallest crop yields nothing: it is already seen at scale.
 */
/** Why a motion region is, or is not, worth a native crop. */
export type RecoveryRegionVerdict = 'eligible' | 'too-large' | 'covered'

/**
 * The ONE place the two region gates are decided. `planRecoveryCrops` filters
 * on it and {@link countRecoverySkips} counts it, so the report can never
 * describe a gate the planner does not actually apply.
 */
function classifyRegion(region: NormalizedRect, uncovered: number): RecoveryRegionVerdict {
  if (area(region) > RECOVERY_MAX_REGION_FRAME_FRACTION) return 'too-large'
  if (uncovered < RECOVERY_MIN_UNCOVERED_FRACTION) return 'covered'
  return 'eligible'
}

/** How the regions of one frame fell against the two gates. */
export interface RecoverySkipCounts {
  readonly tooLarge: number
  readonly covered: number
  readonly eligible: number
}

/**
 * WHY A FRAME PLANNED NO CROP, AS A NUMBER (D378).
 *
 * The pass report counts the passes that RAN, so "the second pass stops running
 * when a person is beside the dog" — a plausible reading of
 * {@link RECOVERY_MAX_REGION_FRAME_FRACTION} and
 * {@link RECOVERY_MIN_UNCOVERED_FRACTION}, and a live hypothesis on camera 101
 * — could not be confirmed or killed from the logs at all. This classifies the
 * regions a frame offered, against the same predicate the planner filters on.
 */
export function countRecoverySkips(input: RecoveryPlanInput): RecoverySkipCounts {
  let tooLarge = 0
  let covered = 0
  let eligible = 0
  for (const region of input.regions) {
    switch (classifyRegion(region, uncoveredFraction(region, input.detections))) {
      case 'too-large':
        tooLarge += 1
        break
      case 'covered':
        covered += 1
        break
      case 'eligible':
        eligible += 1
        break
    }
  }
  return { tooLarge, covered, eligible }
}

export function planRecoveryCrops(input: RecoveryPlanInput): readonly RecoveryCrop[] {
  const { native } = input
  if (Math.min(native.width, native.height) < RECOVERY_CROP_MIN_SIDE_PX) return []
  const ranked = input.regions
    .map((region) => ({ region, uncovered: uncoveredFraction(region, input.detections) }))
    .filter(({ region, uncovered }) => classifyRegion(region, uncovered) === 'eligible')
    .toSorted((a, b) => area(b.region) * b.uncovered - area(a.region) * a.uncovered)

  const planned: RecoveryCrop[] = []
  for (const { region } of ranked) {
    for (const crop of cropsForRegion(region, native)) {
      if (planned.length >= RECOVERY_MAX_CROPS_PER_FRAME) return planned
      const centreX = crop.left + crop.side / 2
      const centreY = crop.top + crop.side / 2
      if (planned.some((existing) => contains(existing, centreX, centreY))) continue
      planned.push(crop)
    }
  }
  return planned
}

/**
 * Boxes the executor produced on the crop VIEW → the result's own space.
 *
 * Three spaces meet here: the view the model saw (`view`, ≤640 px), the native
 * square it was cut from (`crop`, native px) and the space the full-frame
 * result reports in (`result`, native px on the `frameRef` path, the inline
 * ≤640 view otherwise). A box touching the view edge was clipped by the crop
 * and is dropped: half a person is not a person, and the tracker would take
 * the half as the whole.
 */
export function remapCropDetections(
  detections: readonly ObjectDetection[],
  crop: RecoveryCrop,
  view: FrameDims,
  result: FrameDims,
  native: FrameDims,
): readonly ObjectDetection[] {
  const viewToNative = crop.side / Math.max(1, view.width)
  const nativeToResultX = result.width / Math.max(1, native.width)
  const nativeToResultY = result.height / Math.max(1, native.height)
  const out: ObjectDetection[] = []
  for (const detection of detections) {
    const { x, y, width, height } = detection.bbox
    const clipped =
      x <= RECOVERY_EDGE_MARGIN_PX ||
      y <= RECOVERY_EDGE_MARGIN_PX ||
      x + width >= view.width - RECOVERY_EDGE_MARGIN_PX ||
      y + height >= view.height - RECOVERY_EDGE_MARGIN_PX
    if (clipped) continue
    out.push({
      ...detection,
      // WHAT THIS PASS ACTUALLY MEASURED, carried with the box (D377).
      //
      // This is already a second look: the same detector, the same frame,
      // better pixels. Downstream, the confirmation gate's job is to ask
      // exactly that question of a birth — and it answers it by cutting a
      // THIRD crop, tighter and capped at 320 px wide, whose verdict on this
      // subject is a coin flip (camera 101, 2026-09-07 06:59:38: confirmed at
      // 0.7068, then the very next frame no compatible detection at all). A
      // gate that can read the measurement that saw the subject does not need
      // to take a worse one.
      nativeRecovery: {
        score: detection.score,
        cropSidePx: crop.side,
        viewPx: view.width,
      },
      bbox: {
        x: (crop.left + x * viewToNative) * nativeToResultX,
        y: (crop.top + y * viewToNative) * nativeToResultY,
        width: width * viewToNative * nativeToResultX,
        height: height * viewToNative * nativeToResultY,
      },
    })
  }
  return out
}

interface PixelBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function boxIntersection(a: PixelBox, b: PixelBox): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return w * h
}

function sameSubject(recovered: PixelBox, existing: PixelBox): boolean {
  const inter = boxIntersection(recovered, existing)
  if (inter <= 0) return false
  const areaR = recovered.width * recovered.height
  const areaE = existing.width * existing.height
  const union = areaR + areaE - inter
  if (union > 0 && inter / union >= RECOVERY_FUSE_IOU) return true
  return areaR > 0 && inter / areaR >= RECOVERY_FUSE_CONTAINMENT
}

/**
 * Class-aware NMS of the recovered boxes against the full-frame ones. Every
 * full-frame box is kept as it is — the second pass only ADDS. A recovered box
 * is added when no full-frame box of the same macro class is the same subject
 * (`RECOVERY_FUSE_IOU`) or contains it (`RECOVERY_FUSE_CONTAINMENT`). Ids are
 * re-minted so a crop's `d0` cannot collide with the frame's.
 */
export function fuseRecoveredDetections(
  full: readonly ObjectDetection[],
  recovered: readonly ObjectDetection[],
): readonly ObjectDetection[] {
  const accepted: ObjectDetection[] = []
  for (const [index, candidate] of recovered.entries()) {
    const duplicate = [...full, ...accepted].some(
      (existing) =>
        existing.macroClass === candidate.macroClass && sameSubject(candidate.bbox, existing.bbox),
    )
    if (duplicate) continue
    accepted.push({ ...candidate, id: `recovered-${index}-${candidate.id}` })
  }
  return [...full, ...accepted]
}

/**
 * The step the second pass runs: the enabled first-level object detector of
 * the camera's own tree, with its own model and no children. Same model as
 * the full pass so a recovered box is comparable to a full-frame one.
 */
export function selectRecoveryStep(
  steps: readonly PipelineStepInputOutput[],
): PipelineStepInputOutput | null {
  const detector = steps.find(
    (step) => step.addonId === OBJECT_DETECTION_STEP_ID && step.enabled !== false,
  )
  if (!detector) return null
  return {
    addonId: detector.addonId,
    ...(detector.modelId !== undefined ? { modelId: detector.modelId } : {}),
    enabled: true,
  }
}
