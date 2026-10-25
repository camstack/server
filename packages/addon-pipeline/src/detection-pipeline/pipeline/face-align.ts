/**
 * Face alignment — landmark-based similarity warp to the ArcFace template.
 *
 * ArcFace (and most face-recognition embedders) are only discriminative when
 * the input is a *landmark-aligned* 112x112 crop: eyes, nose and mouth corners
 * must land on fixed canonical positions. Feeding a raw axis-aligned bbox crop
 * stretched to 112x112 (the previous behaviour) collapses embeddings toward a
 * common direction — different people end up with ~0.99 cosine similarity.
 *
 * This module computes the least-squares similarity transform (rotation +
 * uniform scale + translation, the cv2.estimateAffinePartial2D recipe) that
 * maps SCRFD's 5 facial landmarks onto the canonical template, then resamples
 * the source pixels into a fixed-size aligned crop with bilinear interpolation.
 *
 * The warp is done in pure JS on a raw RGB buffer (a few thousand samples per
 * face — negligible cost) so it is fully deterministic and unit-testable, and
 * needs no native affine primitive nor any change to the Python inference pool.
 */

import sharp from 'sharp'
import type { AbsoluteBbox } from './crop-utils.js'

export interface Pt {
  readonly x: number
  readonly y: number
}

/**
 * A 2D similarity transform `dst = M·src + t` where the linear part is
 * constrained to rotation + uniform scale:
 *   M = [[a, -b], [b, a]]
 *   dst.x = a*src.x - b*src.y + tx
 *   dst.y = b*src.x + a*src.y + ty
 */
export interface SimilarityTransform {
  readonly a: number
  readonly b: number
  readonly tx: number
  readonly ty: number
}

/**
 * Canonical ArcFace 5-point template for a 112x112 aligned crop
 * (insightface reference points). Order matches SCRFD landmark output:
 * left-eye, right-eye, nose, left-mouth-corner, right-mouth-corner.
 */
export const ARCFACE_TEMPLATE_112: readonly Pt[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
] as const

/**
 * Closed-form least-squares similarity fit mapping `src` points onto `dst`
 * points (both must be the same length ≥ 2). Recovers rotation, uniform scale
 * and translation. When `dst` is an exact similarity image of `src` the fit is
 * exact. Throws if the source points are degenerate (all coincident).
 */
export function computeSimilarityTransform(
  src: readonly Pt[],
  dst: readonly Pt[],
): SimilarityTransform {
  const n = src.length
  if (n < 2 || dst.length !== n) {
    throw new Error(
      `computeSimilarityTransform: need ≥2 matched points, got src=${n} dst=${dst.length}`,
    )
  }

  let msx = 0,
    msy = 0,
    mdx = 0,
    mdy = 0
  for (let i = 0; i < n; i++) {
    msx += src[i]!.x
    msy += src[i]!.y
    mdx += dst[i]!.x
    mdy += dst[i]!.y
  }
  msx /= n
  msy /= n
  mdx /= n
  mdy /= n

  let sxx = 0 // Σ ||src'||²
  let numA = 0 // Σ (sx'·dx' + sy'·dy')
  let numB = 0 // Σ (sx'·dy' - sy'·dx')
  for (let i = 0; i < n; i++) {
    const sx = src[i]!.x - msx
    const sy = src[i]!.y - msy
    const dx = dst[i]!.x - mdx
    const dy = dst[i]!.y - mdy
    sxx += sx * sx + sy * sy
    numA += sx * dx + sy * dy
    numB += sx * dy - sy * dx
  }
  if (sxx === 0) {
    throw new Error('computeSimilarityTransform: degenerate source points (zero variance)')
  }

  const a = numA / sxx
  const b = numB / sxx
  const tx = mdx - (a * msx - b * msy)
  const ty = mdy - (b * msx + a * msy)
  return { a, b, tx, ty }
}

/** Invert a similarity transform: given `dst = T·src`, return `T⁻¹` (`src = T⁻¹·dst`). */
export function invertSimilarity(t: SimilarityTransform): SimilarityTransform {
  const det = t.a * t.a + t.b * t.b
  if (det === 0) throw new Error('invertSimilarity: non-invertible transform (a=b=0)')
  const a = t.a / det
  const b = -t.b / det
  // src = M⁻¹·(dst - t) = M⁻¹·dst - M⁻¹·t
  const tx = -(a * t.tx - b * t.ty)
  const ty = -(b * t.tx + a * t.ty)
  return { a, b, tx, ty }
}

/** Apply a similarity transform to a point. */
export function applySimilarity(t: SimilarityTransform, p: Pt): Pt {
  return {
    x: t.a * p.x - t.b * p.y + t.tx,
    y: t.b * p.x + t.a * p.y + t.ty,
  }
}

export interface RawImage {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  readonly channels: number
}

/**
 * Resample `src` into a `outSize × outSize` aligned crop so that `landmarks`
 * land on `template`. Bilinear interpolation; source coordinates are clamped to
 * the image border (no wrap, no out-of-frame artefacts). Pure function over the
 * raw buffer — callers handle decode/encode.
 */
export function warpToTemplate(
  src: RawImage,
  landmarks: readonly Pt[],
  template: readonly Pt[] = ARCFACE_TEMPLATE_112,
  outSize = 112,
): RawImage {
  const ch = src.channels
  const fwd = computeSimilarityTransform(landmarks, template) // src → template
  const inv = invertSimilarity(fwd) // template(output) → src
  const out = new Uint8Array(outSize * outSize * ch)
  const maxX = src.width - 1
  const maxY = src.height - 1

  for (let oy = 0; oy < outSize; oy++) {
    for (let ox = 0; ox < outSize; ox++) {
      // Sample at pixel centres for a stable, symmetric mapping.
      let sx = inv.a * (ox + 0.5) - inv.b * (oy + 0.5) + inv.tx - 0.5
      let sy = inv.b * (ox + 0.5) + inv.a * (oy + 0.5) + inv.ty - 0.5
      if (sx < 0) sx = 0
      else if (sx > maxX) sx = maxX
      if (sy < 0) sy = 0
      else if (sy > maxY) sy = maxY

      const x0 = Math.floor(sx),
        y0 = Math.floor(sy)
      const x1 = x0 < maxX ? x0 + 1 : x0
      const y1 = y0 < maxY ? y0 + 1 : y0
      const fx = sx - x0,
        fy = sy - y0
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx * fy

      const i00 = (y0 * src.width + x0) * ch
      const i10 = (y0 * src.width + x1) * ch
      const i01 = (y1 * src.width + x0) * ch
      const i11 = (y1 * src.width + x1) * ch
      const o = (oy * outSize + ox) * ch
      for (let c = 0; c < ch; c++) {
        out[o + c] = Math.round(
          src.data[i00 + c]! * w00 +
            src.data[i10 + c]! * w10 +
            src.data[i01 + c]! * w01 +
            src.data[i11 + c]! * w11,
        )
      }
    }
  }
  return { data: out, width: outSize, height: outSize, channels: ch }
}

/** Short side (px) of an absolute [x1,y1,x2,y2] bbox. */
export function bboxShortSide(bbox: AbsoluteBbox): number {
  return Math.min(bbox[2] - bbox[0], bbox[3] - bbox[1])
}

// ---------------------------------------------------------------------------
// Native-crop-aware alignment (design B — embed on the NATIVE face crop)
// ---------------------------------------------------------------------------

/** A rectangular region of the frame in absolute (detection-space) pixels. */
export interface PixelRegion {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** Raw RGB pixels of a crop plus its actual dimensions (native-crop result). */
export interface RgbCrop {
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
}

/** Normalized [0,1] bbox — the shape the runner's native-crop cap consumes. */
export interface NormalizedRoi {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Best-effort NATIVE-resolution crop of a normalized ROI, bound to the frame
 * being processed. Returns `null` on a miss (surface evicted / unsupported) so
 * the caller falls back to the downscaled full-frame crop. `maxWidth` caps the
 * returned crop width so a full-native face region never floods the transport.
 */
export type NativeFaceCropProvider = (
  roi: NormalizedRoi,
  maxWidth?: number,
) => Promise<RgbCrop | null>

/**
 * Padded region (clamped to the frame) around a face bbox — the area a native
 * crop must cover so the warp has room around a tilted / edge face. Mirrors the
 * padding {@link alignFaceCrop} applies internally (`padRatio` default 0.4), so
 * the native and fallback paths sample the same neighbourhood.
 */
export function paddedFaceRegion(
  faceBbox: AbsoluteBbox,
  imageWidth: number,
  imageHeight: number,
  padRatio = 0.4,
): PixelRegion {
  const bw = faceBbox[2] - faceBbox[0]
  const bh = faceBbox[3] - faceBbox[1]
  const padX = bw * padRatio
  const padY = bh * padRatio
  return {
    left: Math.max(0, Math.floor(faceBbox[0] - padX)),
    top: Math.max(0, Math.floor(faceBbox[1] - padY)),
    right: Math.min(imageWidth, Math.ceil(faceBbox[2] + padX)),
    bottom: Math.min(imageHeight, Math.ceil(faceBbox[3] + padY)),
  }
}

/**
 * Warp a raw RGB crop of `region` (native-resolution pixels of exactly that
 * detection-space region) so `landmarksImageSpace` land on the ArcFace
 * template. Landmarks are mapped from image space into the crop's local pixel
 * space by the per-axis region→crop scale (handles `maxWidth` downscale of the
 * native crop). Channels default to RGB (3) — the format the decode worker's
 * native surface produces.
 */
export async function alignFaceCropFromRgb(
  rgb: RgbCrop,
  region: PixelRegion,
  landmarksImageSpace: readonly Pt[],
  opts: { outSize?: number; template?: readonly Pt[]; quality?: number; channels?: number } = {},
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const outSize = opts.outSize ?? 112
  const quality = opts.quality ?? 95
  const channels = opts.channels ?? 3
  const regionW = region.right - region.left
  const regionH = region.bottom - region.top
  if (regionW < 1 || regionH < 1) {
    throw new Error(`alignFaceCropFromRgb: degenerate region ${regionW}x${regionH}`)
  }
  if (rgb.width < 2 || rgb.height < 2) {
    throw new Error(`alignFaceCropFromRgb: degenerate crop ${rgb.width}x${rgb.height}`)
  }
  const scaleX = rgb.width / regionW
  const scaleY = rgb.height / regionH
  const localLandmarks: Pt[] = landmarksImageSpace.map((l) => ({
    x: (l.x - region.left) * scaleX,
    y: (l.y - region.top) * scaleY,
  }))
  const aligned = warpToTemplate(
    { data: rgb.bytes, width: rgb.width, height: rgb.height, channels },
    localLandmarks,
    opts.template ?? ARCFACE_TEMPLATE_112,
    outSize,
  )
  const jpeg = await sharp(Buffer.from(aligned.data), {
    raw: {
      width: aligned.width,
      height: aligned.height,
      channels: aligned.channels as 1 | 2 | 3 | 4,
    },
  })
    .jpeg({ quality })
    .toBuffer()
  return { jpeg, width: aligned.width, height: aligned.height }
}

/**
 * Produce a landmark-aligned face crop, preferring a NATIVE-resolution crop
 * (design B — the quality win) and FALLING BACK to today's downscaled
 * full-frame alignment on any native miss/error (never worse than before).
 *
 * The native path requests the padded face region from `nativeCropProvider`
 * (a best-effort local cap round-trip bound to this frame), warps the native
 * pixels; the fallback path re-uses {@link alignFaceCrop} on the downscaled
 * JPEG. ArcFace input is a fixed `outSize`×`outSize` either way — only the crop
 * SOURCE changes, so model cost is unchanged.
 */
export async function buildAlignedFaceCrop(args: {
  fullFrameJpeg: Buffer
  faceBbox: AbsoluteBbox
  landmarksImageSpace: readonly Pt[]
  imageWidth: number
  imageHeight: number
  outSize: number
  nativeCropProvider?: NativeFaceCropProvider
  nativeMaxWidth?: number
}): Promise<{
  jpeg: Buffer
  width: number
  height: number
  source: 'native' | 'fallback'
  /**
   * The face bbox short side (px) measured in the NATIVE crop's resolution —
   * `detection short side × (native crop / detection region scale)`. Present
   * ONLY when the crop came from a native surface, so a caller can gate on the
   * NATIVE face size (a face small in the downscaled detection frame may be
   * large enough to embed at native res). Absent on the fallback path (gate on
   * the detection size there).
   */
  nativeFaceShortSidePx?: number
  /** Diagnostic (native path only): the served native crop + requested region
   *  dimensions, so a gate-time log can expose a scale collapse (native crop
   *  served at region/detection resolution → every face reads "too small"). */
  nativeDiag?: {
    nativeCropW: number
    nativeCropH: number
    regionW: number
    regionH: number
  }
}> {
  if (args.nativeCropProvider) {
    try {
      const region = paddedFaceRegion(args.faceBbox, args.imageWidth, args.imageHeight)
      const roi: NormalizedRoi = {
        x: region.left / args.imageWidth,
        y: region.top / args.imageHeight,
        w: (region.right - region.left) / args.imageWidth,
        h: (region.bottom - region.top) / args.imageHeight,
      }
      const native = await args.nativeCropProvider(roi, args.nativeMaxWidth)
      if (
        native &&
        native.width >= 2 &&
        native.height >= 2 &&
        native.bytes.length >= native.width * native.height * 3
      ) {
        const aligned = await alignFaceCropFromRgb(native, region, args.landmarksImageSpace, {
          outSize: args.outSize,
        })
        return {
          ...aligned,
          source: 'native',
          nativeFaceShortSidePx: nativeFaceShortSide(args.faceBbox, region, native),
          nativeDiag: {
            nativeCropW: native.width,
            nativeCropH: native.height,
            regionW: region.right - region.left,
            regionH: region.bottom - region.top,
          },
        }
      }
    } catch {
      // Any native failure → fall through to the downscaled fallback below.
    }
  }
  const fallback = await alignFaceCrop(
    args.fullFrameJpeg,
    args.faceBbox,
    args.landmarksImageSpace,
    args.imageWidth,
    args.imageHeight,
    { outSize: args.outSize },
  )
  return { ...fallback, source: 'fallback' }
}

/**
 * Short side (px) of `faceBbox` (in detection space) re-measured in the NATIVE
 * crop's resolution. The native crop covers `region` (detection-space padded
 * region) rendered at `native.width × native.height` native pixels, so the
 * per-axis scale `native / region` maps the detection face size to its native
 * size. This is the size an embedder actually sees, so the gate uses it.
 */
export function nativeFaceShortSide(
  faceBbox: AbsoluteBbox,
  region: PixelRegion,
  native: RgbCrop,
): number {
  const regionW = Math.max(1, region.right - region.left)
  const regionH = Math.max(1, region.bottom - region.top)
  const scaleX = native.width / regionW
  const scaleY = native.height / regionH
  const faceW = (faceBbox[2] - faceBbox[0]) * scaleX
  const faceH = (faceBbox[3] - faceBbox[1]) * scaleY
  return Math.min(faceW, faceH)
}

/**
 * Produce an aligned 112x112 JPEG of a face from the full-frame JPEG and the
 * face's 5 landmarks (in absolute image-space coordinates). Decodes a padded
 * region around the face bbox to raw RGB, warps to the ArcFace template, and
 * re-encodes JPEG. The padding gives the warp room to sample around the face
 * when it is tilted or partly outside the tight bbox.
 */
export async function alignFaceCrop(
  fullFrameJpeg: Buffer,
  faceBbox: AbsoluteBbox,
  landmarksImageSpace: readonly Pt[],
  imageWidth: number,
  imageHeight: number,
  opts: { outSize?: number; padRatio?: number; template?: readonly Pt[]; quality?: number } = {},
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const outSize = opts.outSize ?? 112
  const padRatio = opts.padRatio ?? 0.4
  const quality = opts.quality ?? 95
  if (landmarksImageSpace.length < 2) {
    throw new Error(`alignFaceCrop: need ≥2 landmarks, got ${landmarksImageSpace.length}`)
  }

  const bw = faceBbox[2] - faceBbox[0]
  const bh = faceBbox[3] - faceBbox[1]
  const padX = bw * padRatio
  const padY = bh * padRatio
  const left = Math.max(0, Math.floor(faceBbox[0] - padX))
  const top = Math.max(0, Math.floor(faceBbox[1] - padY))
  const right = Math.min(imageWidth, Math.ceil(faceBbox[2] + padX))
  const bottom = Math.min(imageHeight, Math.ceil(faceBbox[3] + padY))
  const cropW = right - left
  const cropH = bottom - top
  if (cropW < 2 || cropH < 2) {
    throw new Error(`alignFaceCrop: degenerate padded crop ${cropW}x${cropH}`)
  }

  const { data, info } = await sharp(fullFrameJpeg)
    .extract({ left, top, width: cropW, height: cropH })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const localLandmarks: Pt[] = landmarksImageSpace.map((l) => ({ x: l.x - left, y: l.y - top }))
  const aligned = warpToTemplate(
    { data, width: info.width, height: info.height, channels: info.channels },
    localLandmarks,
    opts.template ?? ARCFACE_TEMPLATE_112,
    outSize,
  )

  const jpeg = await sharp(Buffer.from(aligned.data), {
    raw: {
      width: aligned.width,
      height: aligned.height,
      channels: aligned.channels as 1 | 2 | 3 | 4,
    },
  })
    .jpeg({ quality })
    .toBuffer()

  return { jpeg, width: aligned.width, height: aligned.height }
}
