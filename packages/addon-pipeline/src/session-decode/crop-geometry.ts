/**
 * Pure crop/resize geometry for the decode worker — extracted from
 * `decode-worker-child.ts` so the (node-av-free) pixel math is unit-testable.
 * No node-av, no process state: just resolving crop regions + resize targets,
 * including the NATIVE-crop mapping (normalized bbox → even-aligned pixels).
 */
import type { FrameImageOptions } from './video-frame-generator.js'
import type { NormalizedBbox } from './video-frame-generator.js'

/** A resolved, even-aligned crop region in source-frame pixel coordinates. */
export interface ResolvedRegion {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** A resolved resize target dimensions. */
export interface ResizeTarget {
  readonly width: number
  readonly height: number
}

/** A resolved native crop: the even-aligned source region + its (capped) output target. */
export interface ResolvedNativeCrop {
  readonly region: ResolvedRegion
  readonly target: ResizeTarget
}

/** Clamp to [min,max] then floor to the nearest even number (YUV420P chroma is 2x2 subsampled). */
export function clampEven(value: number, min: number, max: number): number {
  const bounded = Math.min(Math.max(value, min), max)
  return bounded - (bounded % 2)
}

/** Resolve `FrameImageOptions.crop` against the decoded frame's dimensions, defaulting to the full frame. */
export function resolveCropRegion(
  frameWidth: number,
  frameHeight: number,
  crop: FrameImageOptions['crop'],
): ResolvedRegion {
  const left = clampEven(crop?.left ?? 0, 0, Math.max(0, frameWidth - 2))
  const top = clampEven(crop?.top ?? 0, 0, Math.max(0, frameHeight - 2))
  const width = clampEven(crop?.width ?? frameWidth - left, 2, frameWidth - left)
  const height = clampEven(crop?.height ?? frameHeight - top, 2, frameHeight - top)
  return { left, top, width, height }
}

/** Resolve `FrameImageOptions.resize`, defaulting to the (already cropped) source dimensions. */
export function resolveResizeTarget(
  cropWidth: number,
  cropHeight: number,
  resize: FrameImageOptions['resize'],
): ResizeTarget {
  if (!resize) return { width: cropWidth, height: cropHeight }
  return {
    width: Math.max(1, Math.round(resize.width)),
    height: Math.max(1, Math.round(resize.height)),
  }
}

/** Whether `region` covers the entire `srcW x srcH` frame (i.e. no real crop). */
export function isFullFrameRegion(region: ResolvedRegion, srcW: number, srcH: number): boolean {
  return region.left === 0 && region.top === 0 && region.width === srcW && region.height === srcH
}

/**
 * Resolve a NORMALIZED [0,1] bbox against a native frame's real pixel dims into
 * an even-aligned pixel crop region. Clamps the box inside the frame so a
 * padded / slightly-out-of-frame bbox never reads past the plane; a degenerate
 * (zero-area) box is widened to the 2px chroma minimum by
 * {@link resolveCropRegion}'s own clamps.
 */
export function normalizedBboxToCrop(
  frameWidth: number,
  frameHeight: number,
  bbox: NormalizedBbox,
): FrameImageOptions['crop'] {
  const left = Math.round(bbox.x * frameWidth)
  const top = Math.round(bbox.y * frameHeight)
  const width = Math.max(2, Math.round(bbox.w * frameWidth))
  const height = Math.max(2, Math.round(bbox.h * frameHeight))
  return { left, top, width, height }
}

/**
 * Aspect-preserving cap of a native crop region to `maxWidth`. Returns
 * `undefined` (no resize → true native crop) when `maxWidth` is absent or the
 * region is already within it.
 */
export function resolveNativeCropTarget(
  region: ResolvedRegion,
  maxWidth: number | undefined,
): FrameImageOptions['resize'] {
  if (maxWidth === undefined || maxWidth <= 0 || region.width <= maxWidth) return undefined
  const width = Math.round(maxWidth)
  const height = Math.max(1, Math.round((width * region.height) / region.width))
  return { width, height }
}

/**
 * Full native-crop geometry: normalized bbox → even-aligned source region +
 * (optionally width-capped) output target. The single mapping the decode worker
 * uses to turn a detection-res bbox into a native-res crop request.
 */
export function resolveNativeCropGeometry(
  frameWidth: number,
  frameHeight: number,
  bbox: NormalizedBbox,
  maxWidth: number | undefined,
): ResolvedNativeCrop {
  const cropPx = normalizedBboxToCrop(frameWidth, frameHeight, bbox)
  const region = resolveCropRegion(frameWidth, frameHeight, cropPx)
  const resize = resolveNativeCropTarget(region, maxWidth)
  const target = resolveResizeTarget(region.width, region.height, resize)
  return { region, target }
}
