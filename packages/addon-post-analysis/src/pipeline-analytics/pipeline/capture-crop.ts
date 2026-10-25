/**
 * `createCaptureCrop` — the ENRICHMENT crop capture shared by the
 * face / plate / clip (object-embedding) / detail-classifier paths.
 *
 * NATIVE-STRICT (S4). Every enrichment crop MUST be cut from the NATIVE frame
 * of the same instant. The capture asks the owning runner for the padded ROI
 * from its retained native surface (`tryNativeCrop`); on a native miss it
 * returns `null` — the enrichment round for that frame is SKIPPED (logged), and
 * the per-track detail scheduler re-runs on a later frame. It NEVER feeds an
 * upscaled or ≤640 detection-raster crop to the models (that produced the blurry
 * mis-recognitions the native-media-persistence rework retires).
 *
 * Pure factory: all IO is injected, so the null-on-miss contract is unit-tested
 * in isolation from the addon boot closure.
 */
import type { FrameHandle, IScopedLogger } from '@camstack/types'
import { REASON_NATIVE_MISS } from '../runtime/failure-report.js'
import { padBbox } from './bbox-pad.js'

/** A bounding box in a frame's own pixel space. */
export interface CaptureCropBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Native ROI → JPEG fetch by handle. Returns a JPEG `Buffer` on a genuine
 * native hit, `null` on ANY miss/error (version skew, expired lease, no native
 * surface). The `paddedNorm` bbox is normalized to `[0,1]`.
 */
export type TryNativeCropFn = (
  frameHandle: FrameHandle,
  paddedNorm: CaptureCropBbox,
  maxWidth?: number,
) => Promise<Buffer | null>

/** Enrichment crop capture: native-first, `null` on a native miss. */
export type CaptureCropFn = (
  frameHandle: FrameHandle,
  bbox: CaptureCropBbox,
  frameWidth: number,
  frameHeight: number,
  padding: number,
  maxWidth?: number,
  /**
   * Only for the miss log's `tags`. A miss RATE is always asked per camera
   * ("why is 636 worse than 101?"), and this line carried `nodeId` alone — so
   * the question could not be answered from the logs while diagnosing the
   * phantom-track defect this parameter was added for.
   */
  deviceId?: number,
) => Promise<Buffer | null>

/**
 * Per-CAMERA outcome note for one crop attempt — the `failure-contribution`
 * counter behind `enrichment-crop`.
 *
 * `reason` absent = the native ROI landed. Called on EVERY attempt, hit
 * included, because a miss count without its attempts is unreadable: this exact
 * number read as "35x worse than yesterday" on 2026-08-28 and was flat across
 * twelve hours once divided by the successes on the same path.
 */
export type NoteCropOutcomeFn = (deviceId: number, reason?: string) => void

export interface CaptureCropDeps {
  readonly tryNativeCrop: TryNativeCropFn
  /** HIT (`true`) / native-miss (`false`) counter for the retention-window metric. */
  readonly bumpCropMetric: (hit: boolean) => void
  /**
   * Per-camera counter. Optional so the pure factory stays constructible in
   * isolation — a caller that omits it gets the pre-counter behaviour, and the
   * addon always supplies it.
   */
  readonly noteCropOutcome?: NoteCropOutcomeFn
  readonly logger: IScopedLogger
}

/**
 * The normalised window a capture asks the runner for: the box padded by
 * `padding` and slid inside the unit square. ONE derivation, shared by the
 * capture below and by any caller that must put a crop-relative box back
 * into the frame (the confirmation gate's secondary subject) — two copies of
 * this arithmetic would drift, and a drifted one places the subject somewhere
 * it is not.
 */
export function captureCropWindow(
  bbox: CaptureCropBbox,
  frameWidth: number,
  frameHeight: number,
  padding: number,
): CaptureCropBbox {
  return padBbox(
    {
      x: bbox.x / frameWidth,
      y: bbox.y / frameHeight,
      w: bbox.w / frameWidth,
      h: bbox.h / frameHeight,
    },
    padding,
  )
}

/** {@link captureCropWindow} in FRAME pixels. */
export function captureCropFrameRect(
  bbox: CaptureCropBbox,
  frameWidth: number,
  frameHeight: number,
  padding: number,
): CaptureCropBbox {
  const window = captureCropWindow(bbox, frameWidth, frameHeight, padding)
  return {
    x: window.x * frameWidth,
    y: window.y * frameHeight,
    w: window.w * frameWidth,
    h: window.h * frameHeight,
  }
}

export function createCaptureCrop(deps: CaptureCropDeps): CaptureCropFn {
  return async (frameHandle, bbox, frameWidth, frameHeight, padding, maxWidth, deviceId) => {
    const paddedNorm = captureCropWindow(bbox, frameWidth, frameHeight, padding)
    // Native-res crop only — the normalized bbox maps directly (the native
    // downscale preserves aspect), so the same [0,1] box addresses the native
    // surface. On a miss we return null: NEVER an upscaled ≤640 raster crop.
    const nativeCrop = await deps.tryNativeCrop(frameHandle, paddedNorm, maxWidth)
    if (nativeCrop) {
      deps.bumpCropMetric(true)
      // The DENOMINATOR. A hit is noted with no reason; without this the miss
      // counter below would be a bare numerator and would move with traffic.
      if (deviceId !== undefined) deps.noteCropOutcome?.(deviceId)
      return nativeCrop
    }
    deps.bumpCropMetric(false)
    if (deviceId !== undefined) deps.noteCropOutcome?.(deviceId, REASON_NATIVE_MISS)
    deps.logger.debug('enrichment crop native miss — detail scheduler will re-run', {
      ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
      meta: { nodeId: frameHandle.nodeId },
    })
    return null
  }
}
