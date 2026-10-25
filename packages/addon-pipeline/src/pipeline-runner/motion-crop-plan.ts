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
 * Pure: no runner state, no IPC, no pixels. It lives in `@camstack/types`
 * (`pipeline/second-pass/`) so the offline accuracy eval plans the same crops;
 * this module re-exports it for the runner.
 */
export {
  applyCropClassFloors,
  CROP_CLASS_FLOORS,
  type CropFloorDrop,
  type CropFloorVerdict,
  MOTION_CROP_DISPATCH_KEY,
  MOTION_CROP_MAX_REGIONS,
  MOTION_CROP_MOTION_PAD,
  MOTION_CROP_TRACKED_PAD,
  planMotionCropRegions,
  planMotionCrops,
  readRecoveryRecipe,
  readRecoveryRecipeForSteps,
  type RecoveryRecipe,
} from '@camstack/types'
