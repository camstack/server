/**
 * Pure decision/plumbing helpers for the `pinnedRgbCrop` native-crop color fix
 * (always on since 2026-07-20 — see `decode-worker-child.ts`).
 *
 * ## The bug this fixes
 *
 * On a HARDWARE decode session the FULL-frame download pins its YUV→RGB
 * conversion to the resolved `(matrix, range)` on the GPU filtergraph
 * (`buildGpuFilterDescription` → `colorConvertFilterOptions`). The native-CROP
 * survival path, however, retains the frame as **YUV420P** and later converts
 * it to RGB with a CPU `SoftwareScaleContext` that node-av exposes NO
 * colorspace-pinning surface for — so it falls back to libswscale's own default
 * coefficients. When the stream carries NO color-matrix metadata
 * (`colorSpace = UNSPECIFIED`, e.g. cam 102), the full frame (pinned bt709/
 * limited via {@link resolveSourceColor}'s defaults) and the crop (CPU-sws
 * default) can resolve DIFFERENTLY → the crop gets a wrong hue / desaturation
 * while the full frame looks right.
 *
 * ## The fix (retain-once-in-pinned-RGB)
 *
 * When the flag is on, the HW→system lease download converts to RGB24 ONCE,
 * pinned to the SAME resolved `(matrix, range)` the full-frame path uses. The
 * later crop is then a pure SPATIAL RGB24→RGB24 crop + resize with NO color
 * math, so it cannot re-resolve color differently than the full frame.
 *
 * These helpers are the PURE decision surface (filter description, cache keys,
 * RAM-budget size) so the plumbing is unit-testable without node-av / ffmpeg.
 * The software-DEGRADE path stays YUV420P (its full frame + crop both use the
 * CPU-sws default, so there is no mismatch to fix there).
 */

import {
  colorConvertFilterOptions,
  sourceColorKey,
  type ResolvedSourceColor,
} from './color-conversion.js'
import { type NativeCropSourceFormat, nativeCropSourceTag } from './planar-crop-source.js'

/**
 * The full-frame GPU→system download filtergraph description.
 *
 * - `color === null` (flag OFF / legacy): download to YUV420P, NO color convert
 *   — byte-for-byte the historical `scale=w=iw:h=ih,hwdownload,format=nv12,format=yuv420p`.
 * - `color !== null` (flag ON): pin the SAME resolved src matrix/range + full-
 *   range RGB output the full-frame path pins, converting to rgb24 in one pass.
 */
export function buildLeaseDownloadDescription(
  scaleFilter: string,
  color: ResolvedSourceColor | null,
): string {
  if (color) {
    return `${scaleFilter}=w=iw:h=ih,hwdownload,format=nv12,scale=${colorConvertFilterOptions(color)},format=rgb24`
  }
  return `${scaleFilter}=w=iw:h=ih,hwdownload,format=nv12,format=yuv420p`
}

/**
 * Cache key for the lease-download filtergraph. Flag OFF returns the historical
 * `${srcW}x${srcH}` key byte-for-byte; flag ON folds the resolved color in so a
 * mid-session colorspace/range change rebuilds the pinned-convert graph instead
 * of reusing one pinned to the old color.
 */
export function leaseDownloadFilterKey(
  srcW: number,
  srcH: number,
  color: ResolvedSourceColor | null,
): string {
  return color ? `${srcW}x${srcH}:rgb:${sourceColorKey(color)}` : `${srcW}x${srcH}`
}

/**
 * Cache key for the dedicated native-crop software scaler. YUV420P (flag OFF /
 * degrade) returns the historical `${srcW}x${srcH}->${dstW}x${dstH}` key
 * byte-for-byte; every other source layout carries its own prefix
 * ({@link nativeCropSourceTag}) so two scalers of identical geometry but
 * different SOURCE format never alias the same cache slot — a scaler built for
 * three planes handed two reads garbage, silently.
 */
export function nativeCropScalerKey(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  srcFormat: NativeCropSourceFormat,
): string {
  return `${nativeCropSourceTag(srcFormat)}${srcW}x${srcH}->${dstW}x${dstH}`
}

/**
 * Approximate resident bytes of a retained software frame, for the lease
 * RAM-budget tally. RGB24 packs 3 bytes/px (~2x YUV420P's 1.5) — the documented
 * cost of pinned-RGB retention.
 */
export function retainedFrameBytes(width: number, height: number, rgb24: boolean): number {
  return rgb24 ? width * height * 3 : Math.ceil(width * height * 1.5)
}

/**
 * Byte offset into a PACKED RGB24 plane for a crop origin — the pure spatial
 * math the `pinnedRgbCrop` crop uses to zero-copy view the ROI. Packed RGB24 is
 * a single plane at 3 bytes/px with NO chroma subsampling, so the offset is a
 * plain `top*stride + left*3` — no half-plane arithmetic and, critically, no
 * color conversion (that already happened, pinned, at download time).
 */
export function rgbCropSourceOffset(top: number, left: number, stride: number): number {
  return top * stride + left * 3
}

/** A zero-copy plane view + the source stride the scaler must read it at. */
export interface RgbCropSource {
  readonly src: Uint8Array
  readonly stride: number
}

/**
 * SIMD tail slack a libswscale row read/write can overshoot by. Matches the
 * 64-byte destination-buffer slack the crop paths already allocate; the SOURCE
 * needs the same guarantee, which the zero-copy stride-offset view does NOT
 * provide for a bottom/right-edge ROI (see {@link resolveRgbCropSource}).
 */
export const RGB_CROP_SIMD_SLACK = 64

/**
 * Resolve the SOURCE the RGB native-crop scaler reads.
 *
 * The fast path is a zero-copy view: offset the packed RGB24 plane to the crop
 * origin and let the scaler stride over it ({@link rgbCropSourceOffset}). That
 * view is safe ONLY while it still holds `stride * height + slack` bytes — the
 * conservative span libswscale reads (full rows + a SIMD overshoot on the last
 * row). For a ROI whose bottom edge sits at (or near) the frame bottom AND whose
 * left offset is > 0, the tail of the plane is `left*3` bytes short of that span,
 * so the scaler reads past the allocation and THROWS — the crop is reported as a
 * native miss. A FULL-frame crop (left=0, full height) is always exactly sized,
 * which is why full-frame keyFrames landed while small offset ROIs missed
 * (the subject-ROI-vs-full-frame asymmetry).
 *
 * When the zero-copy view is too short, repack the ROI into a tightly-packed
 * buffer (stride = `width*3`) with the SIMD tail slack — identical pixels, but
 * guaranteed in-bounds for every ROI position. Pure + exported so the bounds
 * math is unit-testable without node-av.
 */
export function resolveRgbCropSource(
  plane: Uint8Array,
  planeStride: number,
  region: {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  },
): RgbCropSource {
  const offset = rgbCropSourceOffset(region.top, region.left, planeStride)
  const rowBytes = region.width * 3
  const requiredSpan = planeStride * region.height + RGB_CROP_SIMD_SLACK
  if (plane.length - offset >= requiredSpan) {
    return { src: plane.subarray(offset), stride: planeStride }
  }
  // Edge ROI — the zero-copy view is short. Repack the ROI rows tightly.
  const tightStride = rowBytes
  const packed = new Uint8Array(tightStride * region.height + RGB_CROP_SIMD_SLACK)
  for (let row = 0; row < region.height; row++) {
    const srcRowStart = offset + row * planeStride
    packed.set(plane.subarray(srcRowStart, srcRowStart + rowBytes), row * tightStride)
  }
  return { src: packed, stride: tightStride }
}
