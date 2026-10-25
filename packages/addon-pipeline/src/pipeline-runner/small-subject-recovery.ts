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
 * The pure planning lives in `@camstack/types` (`pipeline/second-pass/`) so the
 * offline accuracy eval runs the same planner; this module re-exports it and
 * keeps the one stateful piece, the per-camera motion-region mirror. The
 * runner wires the lease, the executor call and the rate limit around it.
 */
import { type MotionRegion, type NormalizedRect, RECOVERY_MOTION_MAX_AGE_MS } from '@camstack/types'

export {
  countRecoverySkips,
  type FrameDims,
  fuseRecoveredDetections,
  type NormalizedRect,
  normalizedArea,
  planRecoveryCrops,
  RECOVERY_CROP_MAX_SIDE_PX,
  RECOVERY_CROP_MIN_SIDE_PX,
  RECOVERY_CROP_PADDING_RATIO,
  RECOVERY_EDGE_MARGIN_PX,
  RECOVERY_FUSE_CONTAINMENT,
  RECOVERY_FUSE_IOU,
  RECOVERY_MAX_CROPS_PER_FRAME,
  RECOVERY_MAX_REGION_FRAME_FRACTION,
  RECOVERY_MIN_INTERVAL_MS,
  RECOVERY_MIN_UNCOVERED_FRACTION,
  RECOVERY_MOTION_MAX_AGE_MS,
  RECOVERY_VIEW_PX,
  type RecoveryCrop,
  type RecoveryPlanInput,
  type RecoveryRegionVerdict,
  type RecoverySkipCounts,
  remapCropDetections,
  selectRecoveryStep,
  squareAround,
} from '@camstack/types'

interface MirrorEntry {
  readonly regions: readonly NormalizedRect[]
  readonly at: number
}

/**
 * The analyzer's last regions per camera, normalised, with the instant they
 * were measured. Refreshed off the motion path; read on the detection path.
 * A stale entry answers nothing — the regions of two seconds ago are not this
 * frame's. An EMPTY analyzer result replaces the previous regions: motion that
 * stopped is not motion.
 */
export class MotionRegionMirror {
  private readonly byDevice = new Map<number, MirrorEntry>()

  note(
    deviceId: number,
    regions: readonly MotionRegion[],
    frameWidth: number,
    frameHeight: number,
    now: number,
  ): void {
    if (frameWidth <= 0 || frameHeight <= 0) return
    this.byDevice.set(deviceId, {
      at: now,
      regions: regions.map((region) => ({
        x: region.bbox.x / frameWidth,
        y: region.bbox.y / frameHeight,
        w: region.bbox.w / frameWidth,
        h: region.bbox.h / frameHeight,
      })),
    })
  }

  fresh(deviceId: number, now: number): readonly NormalizedRect[] {
    const entry = this.byDevice.get(deviceId)
    if (!entry || now - entry.at > RECOVERY_MOTION_MAX_AGE_MS) return []
    return entry.regions
  }

  forget(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }
}
