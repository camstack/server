/**
 * `createDisplayCrop` — bounded fallback crop capture for DISPLAY consumers
 * (plate/face gallery tiles, `faceCrop`/`plateCrop` event media). This is the
 * DISPLAY counterpart of `createCaptureCrop` (the NATIVE-STRICT enrichment/
 * model-input path, `capture-crop.ts`).
 *
 * The spec's "hard rule — native-source cropping" governs MODEL INPUTS (OCR /
 * embedding / classifier crops), which stay native-or-nothing. A DISPLAY crop
 * that misses the native ROI must still yield SOMETHING an operator can look at,
 * so this path degrades gracefully — always honest, NEVER upscaled.
 *
 * ## The two legs, and why only ONE of them holds pixels
 *
 * This is the subtle part of the file and the reason the dep names carry
 * `Jpeg` / `Rgb`: half of this function crops and half of it does not. Do not
 * re-derive it from the bodies.
 *
 * | # | Leg | What arrives | Pixels here? | Why |
 * | - | --- | --- | --- | --- |
 * | 1 | native ROI | a finished **JPEG** | **no** | the RUNNER already cut this exact rectangle out of its retained native surface and encoded it. There is nothing left to do but store it. Decoding it to re-encode it was a second generation of loss at the same `quality: 90` and five allocations, for a picture nobody on this side looks at. |
 * | 2 | retained full frame | raw **RGB** | **yes** | this is a WHOLE FRAME, not the ROI. The requested region still has to be cut out of it ({@link CropRegionToJpegFn} → `extractCrop`), and cutting needs pixels. |
 * | 3 | total miss | — | — | `null`; the caller skips the write (no upscaled lie). |
 *
 * So leg 1 is a pass-through and leg 2 is a genuine crop, and a change that
 * treats them alike is wrong in one direction or the other. Leg 1 returning
 * `null` — a miss, or a version-skew encode failure — falls through to leg 2.
 *
 * When a fallback (leg 2) is used it logs ONCE per owner (track/event) at info
 * level with the reason, so operators can see the native window is short without
 * flooding the log on every frame.
 *
 * Pure factory: all IO is injected so the fallback-order contract is unit-tested
 * in isolation from the addon boot closure.
 */
import type { FrameHandle, IScopedLogger } from '@camstack/types'
import { padBbox } from './bbox-pad.js'

/** A bounding box in a frame's own pixel space. */
export interface DisplayCropBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A normalized [0,1] region. */
export interface NormalizedRegion {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Raw RGB (24-bit) pixels + their dimensions — the FALLBACK leg's frame, and
 * the only thing in this file that is pixels rather than a finished image.
 * Named for the leg so a reader cannot mistake it for the native ROI, which
 * arrives already encoded.
 */
export interface DisplayFallbackFrameRgb {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
}

/** Which surface a fallback crop came from — the info-log reason. */
export type DisplayFallbackReason = 'keyframe-native' | 'detection-raster'

/**
 * LEG 1 — the native ROI, **already cut and already encoded by the runner**.
 * Returns the JPEG verbatim; nothing here decodes it. `null` on ANY miss/error
 * — the caller then tries the full-frame fallback.
 */
export type FetchNativeRoiJpegFn = (
  frameHandle: FrameHandle,
  paddedNorm: NormalizedRegion,
  maxWidth?: number,
) => Promise<Buffer | null>

/**
 * LEG 2 — a retained FULL frame in raw RGB, tagged with its provenance
 * (keyframe-native when the native surface is still leased, else the runner's
 * ≤640 RAM full frame), or `null` on a total miss. Pixels, because the region
 * still has to be cut out of it here.
 */
export type FetchFallbackFrameRgbFn = (
  frameHandle: FrameHandle,
) => Promise<{ frame: DisplayFallbackFrameRgb; reason: DisplayFallbackReason } | null>

/** LEG 2's cut: crop a normalized region out of a full RGB frame and encode it. */
export type CropRegionToJpegFn = (
  bytes: Buffer,
  width: number,
  height: number,
  norm: NormalizedRegion,
) => Promise<Buffer>

export interface DisplayCropDeps {
  /** Leg 1 — pass-through. See the table in the module doc. */
  readonly fetchNativeRoiJpeg: FetchNativeRoiJpegFn
  /** Leg 2 — pixels, because {@link cropRegionToJpeg} must cut them. */
  readonly fetchFallbackFrame: FetchFallbackFrameRgbFn
  /** Leg 2 only. Leg 1 has no encoder because leg 1 has nothing to encode. */
  readonly cropRegionToJpeg: CropRegionToJpegFn
  readonly logger: IScopedLogger
}

/**
 * Display crop capture: native-first with a bounded full-frame fallback, `null`
 * only on a total miss. `ownerId` (trackId / eventId) keys the once-per-owner
 * fallback info log.
 */
export type DisplayCropFn = (
  frameHandle: FrameHandle,
  bbox: DisplayCropBbox,
  frameWidth: number,
  frameHeight: number,
  padding: number,
  ownerId: string,
  maxWidth?: number,
) => Promise<Buffer | null>

/** Bound the once-per-owner memo so a long-lived process never leaks it. */
const MAX_LOGGED_OWNERS = 5_000

export function createDisplayCrop(deps: DisplayCropDeps): DisplayCropFn {
  const loggedOwners = new Set<string>()
  const logFallbackOnce = (ownerId: string, reason: string): void => {
    if (loggedOwners.has(ownerId)) return
    if (loggedOwners.size >= MAX_LOGGED_OWNERS) loggedOwners.clear()
    loggedOwners.add(ownerId)
    deps.logger.info('display crop fallback used (honest sub-native, not upscaled)', {
      meta: { ownerId, reason },
    })
  }

  return async (frameHandle, bbox, frameWidth, frameHeight, padding, ownerId, maxWidth) => {
    const norm = padBbox(
      {
        x: bbox.x / frameWidth,
        y: bbox.y / frameHeight,
        w: bbox.w / frameWidth,
        h: bbox.h / frameHeight,
      },
      padding,
    )
    // LEG 1 — native ROI. The runner cut this rectangle and encoded it; the
    // JPEG goes to the gallery exactly as it arrived. NO DECODE HERE.
    const nativeJpeg = await deps.fetchNativeRoiJpeg(frameHandle, norm, maxWidth)
    if (nativeJpeg) return nativeJpeg
    // LEG 2 — the retained FULL frame (keyframe-native or the runner's ≤640 RAM
    // tier). This one is pixels on purpose: the ROI is still inside the frame
    // and has to be cut out. Honest, never upscaled.
    const fb = await deps.fetchFallbackFrame(frameHandle)
    if (fb) {
      try {
        const jpeg = await deps.cropRegionToJpeg(
          fb.frame.bytes,
          fb.frame.width,
          fb.frame.height,
          norm,
        )
        logFallbackOnce(ownerId, fb.reason)
        return jpeg
      } catch (err) {
        deps.logger.debug('display crop fallback crop failed', {
          meta: { ownerId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    // LEG 3 — total miss; the caller skips the write (no upscaled lie).
    logFallbackOnce(ownerId, 'unavailable')
    return null
  }
}
