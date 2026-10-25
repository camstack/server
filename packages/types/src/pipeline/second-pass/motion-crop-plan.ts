/**
 * The MEASURED motion-crop recipe (D396) — per camera, default off.
 *
 * ## What this adds to the pass that already exists
 *
 * `small-subject-recovery.ts` ships a second detector pass gated on an
 * UNCOVERED motion region: a region is worth a crop when it is small AND
 * mostly NOT accounted for by a full-frame box. That rule was built to find a
 * subject standing NEXT TO one the detector already sees, and it works.
 *
 * The measurement says the cheaper question is the better one. On camera 101,
 * against the production detector (`yolov9m-320-int8`, python+openvino) on the
 * node that runs that camera, over 38 visually confirmed positive frames from
 * six real animal pass-bys: full-frame recall at our animal floor **24%**,
 * detecting on motion-derived crops **42%**, the same crops with the motion
 * area bar lowered **74%**. Per pass-by 4/6 → 6/6 at our floor, 3/6 → 6/6 at
 * a 0.70 floor. The score distribution moves with it — full frame median
 * 0.780 / p25 0.526, crops 0.840 / p25 0.652.
 *
 * So this rule keeps every moving region, and treats a tracked box that
 * intersects one as a SEED rather than as an exclusion.
 *
 * ## Additive, never substitutive
 *
 * On frames where motion is silent the crop arm scores 0% and the full-frame
 * arm still scores 5% — and the full frame is the only arm that can see a
 * STATIONARY subject at all. Both recipes only ever ADD boxes to the
 * full-frame result; nothing here can remove one.
 *
 * ## Cost
 *
 * Mean 0.25 extra detector invocations per frame at the shipped motion
 * sensitivity and 0.88 at the lowered bar, on the node that would run it. A
 * crop costs about the same as a full frame (45.2 ms vs 40.8 ms p50) — it is
 * not cheaper, it is better aimed — and the whole thing is bounded by the
 * motion duty cycle. The runner's own per-camera rate limit
 * (`RECOVERY_MIN_INTERVAL_MS`) is the ceiling above that.
 *
 * ## What this is NOT (D52)
 *
 * Not a detail/CLIP crop, for the same reason `small-subject-recovery.ts` is
 * not one: `deriveDetailCropRect` derives the rectangle an enrichment step is
 * fed from a KNOWN subject box, and `object-clip` is one vector index that
 * tolerates exactly one such derivation. This module derives a square from a
 * MOTION region, before any subject exists, for the FIRST-LEVEL detector; its
 * output is a detection, never a vector. Nothing here calls the detail
 * derivation and nothing here may be reused for one.
 *
 * Pure: no runner state, no IPC, no pixels.
 *
 * Lives in `@camstack/types` so the live runner (`addon-pipeline`) and the
 * offline accuracy evaluation (`addon-benchmark`) plan the SAME crops: one
 * module, two callers, no copy to drift.
 */
import type { ObjectDetection } from '../../types/detection.js'
import type { PipelineStepInputOutput } from '../../capabilities/pipeline-executor.cap.js'
import {
  OBJECT_DETECTION_STEP_ID,
  type FrameDims,
  type NormalizedRect,
  normalizedArea,
  RECOVERY_CROP_MAX_SIDE_PX,
  RECOVERY_CROP_MIN_SIDE_PX,
  type RecoveryCrop,
  type RecoveryPlanInput,
  squareAround,
} from './small-subject-recovery.js'

/**
 * Which region rule this camera's second pass runs.
 *
 * The selector is per camera and defaults to the shipped rule, exactly like
 * the motion area bar's own `minArea: 0` opt-in (D394): a deploy changes
 * nothing until an operator moves a camera.
 */
export type RecoveryRecipe = 'uncovered-region' | 'motion-crop'

/**
 * Step-settings key of the opt-in, on the `object-detection` step — so it is
 * per camera through `pipelineOrchestrator.setCameraStepSettings` (a
 * camera-semantic key, D927), and it rides the same
 * `PipelineStepInputOutput.settings` the per-macro confidence floors ride.
 */
export const MOTION_CROP_DISPATCH_KEY = 'motionCropDispatch'

/**
 * Read the opt-in. Anything that is not the boolean `true` is the shipped
 * rule: a stored string or a number is a mis-write (this repo has shipped a
 * setting written into the wrong sqlite table before), and a mis-write must
 * not silently change what a camera detects on.
 */
export function readRecoveryRecipe(
  settings: Readonly<Record<string, unknown>> | undefined,
): RecoveryRecipe {
  return settings?.[MOTION_CROP_DISPATCH_KEY] === true ? 'motion-crop' : 'uncovered-region'
}

/**
 * The recipe this camera's resolved step tree selects.
 *
 * Reads the ENABLED first-level detector's own settings, which is where
 * `pipelineOrchestrator.setCameraStepSettings` writes a per-camera value. A
 * tree with no enabled detector runs no second pass at all, so the answer
 * there is the shipped rule and it is never used.
 */
export function readRecoveryRecipeForSteps(
  steps: readonly PipelineStepInputOutput[],
): RecoveryRecipe {
  const detector = steps.find(
    (step) => step.addonId === OBJECT_DETECTION_STEP_ID && step.enabled !== false,
  )
  return readRecoveryRecipe(detector?.settings)
}

/**
 * A motion box is grown ×1.5 about its centre before anything else.
 *
 * The motion step's box is the CHANGED pixels, which on a moving animal is the
 * leading edge plus its shadow, not the animal. The detector needs the subject
 * and the context it was trained on.
 */
export const MOTION_CROP_MOTION_PAD = 1.5
/**
 * An intersecting tracked box is grown ×1.25 — less, because it is already a
 * subject rectangle rather than a change mask.
 */
export const MOTION_CROP_TRACKED_PAD = 1.25
/**
 * Regions per frame, largest area first.
 *
 * Measured as NON-BINDING: over the 156 frames of the recall harness the cap
 * bound on 0 of them. It is the bound on a storm, not a tuning knob, and the
 * runner reports when it binds so a camera on which it starts to is visible.
 */
export const MOTION_CROP_MAX_REGIONS = 3

/**
 * The floor a `person` or `vehicle` box must clear when it came out of a CROP
 * rather than out of the full frame.
 *
 * Collected, not assumed: 3 085 quiet frames produced 27 motion-positive
 * frames and 28 crop invocations. The full-frame arm produced 0 boxes above
 * any gate; the crop arm produced 3, of which two are genuine false positives,
 * and both are night-IR corners upscaled into a 320 model — `vehicle 0.749`
 * and `person 0.701`. Zero false `animal` at any gate, which is why `animal`
 * is deliberately absent from this table: the class the pass exists to recover
 * is the class that never produced a false positive, and gating it would cost
 * the whole measured gain.
 *
 * This is a CROP-ONLY floor, applied on top of the per-macro floors the
 * executor already enforced. A full-frame `person` at 0.70 is untouched — the
 * full-frame arm is the one arm with ground truth behind its floor
 * (`minConfidencePerson` 0.65, raised on 2026-07-30 from a measured
 * distribution).
 *
 * The cost of this floor is stated rather than assumed away: it can also
 * remove a real distant person or vehicle recovered from a crop at 0.70–0.80.
 * Nothing in the quiet-footage sample measures that, so the floor is a
 * constant here rather than a slider, and the runner reports every drop it
 * makes per camera.
 */
export const CROP_CLASS_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  person: 0.8,
  vehicle: 0.8,
})

/** One box the crop floor removed, with the numbers that removed it. */
export interface CropFloorDrop {
  readonly macroClass: string
  readonly score: number
  readonly floor: number
}

/** What {@link applyCropClassFloors} kept, and everything it did not. */
export interface CropFloorVerdict {
  readonly kept: readonly ObjectDetection[]
  readonly dropped: readonly CropFloorDrop[]
}

/**
 * Apply the crop-only class floors, REPORTING every drop.
 *
 * A class with no entry in {@link CROP_CLASS_FLOORS} is kept: a floor this
 * table cannot express is not a floor of zero, and silently dropping a class
 * nobody measured is the exact shape of silent drop this repo has paid for
 * three separate times.
 */
export function applyCropClassFloors(detections: readonly ObjectDetection[]): CropFloorVerdict {
  const kept: ObjectDetection[] = []
  const dropped: CropFloorDrop[] = []
  for (const detection of detections) {
    const floor = CROP_CLASS_FLOORS[detection.macroClass]
    if (floor !== undefined && detection.score < floor) {
      dropped.push({ macroClass: detection.macroClass, score: detection.score, floor })
      continue
    }
    kept.push(detection)
  }
  return { kept, dropped }
}

function scaleAbout(rect: NormalizedRect, factor: number): NormalizedRect {
  const w = rect.w * factor
  const h = rect.h * factor
  return { x: rect.x + rect.w / 2 - w / 2, y: rect.y + rect.h / 2 - h / 2, w, h }
}

function overlaps(a: NormalizedRect, b: NormalizedRect): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  )
}

function union(a: NormalizedRect, b: NormalizedRect): NormalizedRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  }
}

function clampToFrame(rect: NormalizedRect): NormalizedRect {
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  return { x, y, w: Math.min(1, rect.x + rect.w) - x, h: Math.min(1, rect.y + rect.h) - y }
}

/**
 * Merge transitively every seed whose padded box overlaps another, and answer
 * the union rectangles.
 *
 * Transitive on purpose: a person, the dog beside them and the dog's shadow
 * are three components of one subject, and cutting three crops for them spends
 * two inferences on pixels the first one already showed the detector.
 */
function mergeSeeds(seeds: readonly NormalizedRect[]): readonly NormalizedRect[] {
  const merged: NormalizedRect[] = []
  for (const seed of seeds) {
    let current = seed
    let changed = true
    while (changed) {
      changed = false
      for (let i = merged.length - 1; i >= 0; i -= 1) {
        const other = merged[i]
        if (other === undefined || !overlaps(current, other)) continue
        current = union(current, other)
        merged.splice(i, 1)
        changed = true
      }
    }
    merged.push(current)
  }
  return merged
}

/**
 * The regions the measured recipe judges this frame on.
 *
 * Motion boxes padded {@link MOTION_CROP_MOTION_PAD}; every full-frame box
 * that intersects a RAW motion box padded {@link MOTION_CROP_TRACKED_PAD} and
 * added as a seed of its own; everything that overlaps merged; the result
 * clamped to the frame, ordered largest first and capped at
 * {@link MOTION_CROP_MAX_REGIONS}.
 *
 * There is deliberately no coverage gate and no size gate here. Those belong
 * to the shipped rule, and they are what makes it a rule about a subject
 * BESIDE a detected one; the measurement says the pass is worth running on the
 * detected subject's own region too.
 */
export function planMotionCropRegions(input: RecoveryPlanInput): readonly NormalizedRect[] {
  if (input.regions.length === 0) return []
  const seeds: NormalizedRect[] = input.regions.map((r) => scaleAbout(r, MOTION_CROP_MOTION_PAD))
  for (const detection of input.detections) {
    if (!input.regions.some((region) => overlaps(detection, region))) continue
    seeds.push(scaleAbout(detection, MOTION_CROP_TRACKED_PAD))
  }
  return mergeSeeds(seeds)
    .map(clampToFrame)
    .filter((r) => r.w > 0 && r.h > 0)
    .toSorted((a, b) => normalizedArea(b) - normalizedArea(a))
    .slice(0, MOTION_CROP_MAX_REGIONS)
}

/**
 * The square the detector is fed for one measured region.
 *
 * "Grow to the detector's input aspect ratio without ever shrinking" is a
 * SQUARE here, and that is a fact about the production detector rather than a
 * simplification: `yolov9m-320-int8` takes 320×320, as does every hardware
 * default in the catalog.
 *
 * The side is the region's longer side, floored at
 * {@link RECOVERY_CROP_MIN_SIDE_PX} — the growth is what magnifies the subject
 * — and ceilinged at {@link RECOVERY_CROP_MAX_SIDE_PX}. The ceiling is NOT a
 * simplification either: at 1024 px the same 320 model scored the reference
 * dog 0.52–0.76, and at 1280 px lost it entirely
 * (`docs/benchmarks/pipeline-frame-model-eval.md`, case `miss-dog-101`). A
 * region longer than the ceiling is TILED along its longer axis, never zoomed
 * out.
 */
function motionCropsForRegion(region: NormalizedRect, native: FrameDims): readonly RecoveryCrop[] {
  const widthPx = region.w * native.width
  const heightPx = region.h * native.height
  const longest = Math.max(widthPx, heightPx)
  const side = Math.round(
    Math.min(Math.max(longest, RECOVERY_CROP_MIN_SIDE_PX), RECOVERY_CROP_MAX_SIDE_PX),
  )
  const centreX = (region.x + region.w / 2) * native.width
  const centreY = (region.y + region.h / 2) * native.height
  if (longest <= RECOVERY_CROP_MAX_SIDE_PX) return [squareAround(centreX, centreY, side, native)]
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

/** `true` when `inner` lies entirely inside `outer`. */
function cropContains(outer: RecoveryCrop, inner: RecoveryCrop): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.side <= outer.left + outer.side &&
    inner.top + inner.side <= outer.top + outer.side
  )
}

/**
 * The crops the measured recipe runs on this frame.
 *
 * Dedupe is by CONTAINMENT only. Two squares that merely overlap both run: the
 * pixels the second adds are pixels no other crop shows the detector, and the
 * fusion step downstream already refuses a duplicate BOX. Dropping a crop
 * because it overlapped would drop the subject sitting at its edge, which is
 * the whole population this pass exists for.
 *
 * A frame that cannot hold the smallest crop yields nothing: it is already
 * seen at scale.
 */
export function planMotionCrops(input: RecoveryPlanInput): readonly RecoveryCrop[] {
  const { native } = input
  if (Math.min(native.width, native.height) < RECOVERY_CROP_MIN_SIDE_PX) return []
  const planned: RecoveryCrop[] = []
  for (const region of planMotionCropRegions(input)) {
    for (const crop of motionCropsForRegion(region, native)) {
      if (planned.some((existing) => cropContains(existing, crop))) continue
      planned.push(crop)
    }
  }
  return planned
}
