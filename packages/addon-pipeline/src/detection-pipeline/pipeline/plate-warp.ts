/**
 * Plate-crop WARP — perspective rectification of a licence-plate ROI to a
 * canonical, aspect-locked text strip, run immediately before the CTC reader.
 *
 * WHY this exists on top of {@link ./plate-deskew.rectifyPlateJpeg}
 * ----------------------------------------------------------------
 * The detector hands OCR an AXIS-ALIGNED box around a plate that, on an oblique
 * camera, is a rotated trapezoid inside it. Two things then destroy the read,
 * and neither is a resolution problem:
 *
 *  1. **Aspect.** A German plate is 4.7 : 1. The boxes cam 102 produces measure
 *     1.3 – 2.0 : 1 — the box is 2-3× too tall because it circumscribes a
 *     tilted rectangle. The recognizer resizes its input to a fixed 64px height
 *     preserving aspect, so a 1.5 : 1 tile becomes ~96px wide: seven glyphs get
 *     ~13px each. The same plate rectified to 4.7 : 1 arrives ~300px wide.
 *  2. **Tilt.** The 2026-08 deskew estimator searches ±16° and REJECTS an
 *     unbracketed optimum (D186) — correct, and it means it returns 0° on this
 *     camera, whose plates sit at 24-31°. The rotation is real; the projection
 *     profile just cannot measure it from a box that is mostly car.
 *
 * The plate itself is the one thing in the ROI that is reliably a large, bright,
 * convex blob. So: Otsu-threshold the tile, keep the largest bright connected
 * component, take its four extreme corners, and sample that quadrilateral onto
 * a fixed 4.7 : 1 × 64px canvas with bilinear interpolation. One pass, no
 * OpenCV, no new dependency — sharp only decodes and re-encodes, exactly as
 * `plate-deskew.ts` and `native-child-crop.ts` do.
 *
 * MEASURED on 21 ground-truthed cam-102 plate crops (9 distinct vehicles,
 * 2026-08-20 offline replay against the production `vgg_english_g2` weights and
 * the production CTC postprocessor):
 *
 *   | chain                                  | exact | char acc | false on 18 junk ROIs |
 *   | deskew only + 100px gate (live today)  |  0/21 |   4.8 %  | 0 |
 *   | deskew + text-band + 3× upscale        |  0/21 |  16.3 %  | 0 |
 *   | THIS warp + seal-tolerant gate, 85px   |  4/21 |  42.9 %  | 0 |
 *
 * The four exact reads are four DIFFERENT vehicles at 91-98px native plate
 * width — every one of them SKIPPED entirely by the old 100px floor. Upscaling
 * and contrast work (CLAHE, autocontrast, unsharp, 2/3/4× lanczos) moved char
 * accuracy by ≤2 points on their own and are NOT included: the geometry was the
 * whole story.
 */
import sharp from 'sharp'
import { toGrayscale, downscaleGray, type GrayImage, type RawRgbImage } from './plate-deskew.js'

export interface Point {
  readonly x: number
  readonly y: number
}

/** Plate quadrilateral in source-tile pixels, corners in reading order. */
export interface Quad {
  readonly tl: Point
  readonly tr: Point
  readonly br: Point
  readonly bl: Point
}

/**
 * Canonical strip geometry. 4.7 : 1 is the German plate ratio (520 × 110 mm);
 * 64px is the recognizer's own input height, so the warp writes exactly the
 * pixels the model reads and no resampling is wasted.
 */
export const PLATE_STRIP_ASPECT = 4.7
export const PLATE_STRIP_HEIGHT = 64

/**
 * Longest side the blob search runs at. The connected-component pass is O(px)
 * with an explicit stack; capping it keeps a 600px plate ROI at ~1ms.
 */
const BLOB_SEARCH_MAX_DIM = 200

/**
 * The blob must be a plausible plate: neither a speck nor the whole tile, and
 * within a wide-but-finite aspect band. Outside these the caller keeps its
 * un-warped tile — a bad quad is far worse than no quad.
 */
const MIN_BLOB_AREA_FRAC = 0.04
const MAX_BLOB_AREA_FRAC = 0.96
const MIN_QUAD_ASPECT = 1.5
const MAX_QUAD_ASPECT = 9.0
const MIN_QUAD_WIDTH_PX = 12
const MIN_QUAD_HEIGHT_PX = 5

/**
 * Fraction of the plate width dropped from the LEFT edge before sampling.
 * The bright blob's left boundary sits on the plate's black frame / the blue EU
 * band shoulder, and that edge column decodes as a spurious leading glyph
 * ("IDND7578" for DN-D 7578). Swept end to end over the ground-truth set at
 * 0 / 2 / 3.5 / 4 / 5 / 6 / 7 %: 4 % is the peak (4/21 exact, 42.9 % char), the
 * neighbours give 3/21, and 7 % starts eating the first character (0/21).
 */
const LEFT_INSET_FRAC = 0.04

/** Otsu's between-class-variance threshold of a grayscale image. */
export function otsuThreshold(gray: GrayImage): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < gray.data.length; i++) {
    const v = gray.data[i]!
    hist[v] = (hist[v] ?? 0) + 1
  }
  const total = gray.data.length
  if (total === 0) return 128

  let sum = 0
  for (let v = 0; v < 256; v++) sum += v * hist[v]!

  let wB = 0
  let sumB = 0
  let best = 0
  let bestVar = -1
  for (let v = 0; v < 256; v++) {
    wB += hist[v]!
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += v * hist[v]!
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVar) {
      bestVar = between
      best = v
    }
  }
  return best
}

/** `p`-th percentile (0-100) of a grayscale image, via its 256-bin histogram. */
export function percentile(gray: GrayImage, p: number): number {
  const hist = new Int32Array(256)
  for (let i = 0; i < gray.data.length; i++) hist[gray.data[i]!] = (hist[gray.data[i]!] ?? 0) + 1
  const target = (gray.data.length * p) / 100
  let seen = 0
  for (let v = 0; v < 256; v++) {
    seen += hist[v] ?? 0
    if (seen >= target) return v
  }
  return 255
}

/**
 * Mask (1/0, same dimensions) of the LARGEST 4-connected component of pixels
 * strictly above `threshold`. `null` when nothing clears the threshold.
 * Iterative flood fill — a plate ROI is small and recursion depth is not.
 */
export function largestBrightComponent(gray: GrayImage, threshold: number): Uint8Array | null {
  const { data, width, height } = gray
  const n = width * height
  const label = new Int32Array(n)
  const stack: number[] = []
  let current = 0
  let bestLabel = 0
  let bestSize = 0

  for (let seed = 0; seed < n; seed++) {
    if (label[seed] !== 0 || data[seed]! <= threshold) continue
    current += 1
    label[seed] = current
    stack.length = 0
    stack.push(seed)
    let size = 0
    while (stack.length > 0) {
      const i = stack.pop()!
      size += 1
      const x = i % width
      const y = (i - x) / width
      if (x > 0 && label[i - 1] === 0 && data[i - 1]! > threshold) {
        label[i - 1] = current
        stack.push(i - 1)
      }
      if (x < width - 1 && label[i + 1] === 0 && data[i + 1]! > threshold) {
        label[i + 1] = current
        stack.push(i + 1)
      }
      if (y > 0 && label[i - width] === 0 && data[i - width]! > threshold) {
        label[i - width] = current
        stack.push(i - width)
      }
      if (y < height - 1 && label[i + width] === 0 && data[i + width]! > threshold) {
        label[i + width] = current
        stack.push(i + width)
      }
    }
    if (size > bestSize) {
      bestSize = size
      bestLabel = current
    }
  }
  if (bestLabel === 0) return null
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = label[i] === bestLabel ? 1 : 0
  return out
}

/**
 * Four corners of a mask, taken as the extreme points of `x+y` (top-left /
 * bottom-right) and `x−y` (top-right / bottom-left). Exact for a rotated
 * rectangle and stable under the blob noise of a real plate. `null` when the
 * mask is degenerate.
 */
export function quadFromMask(mask: Uint8Array, width: number, height: number): Quad | null {
  let minSum = Number.POSITIVE_INFINITY
  let maxSum = Number.NEGATIVE_INFINITY
  let minDif = Number.POSITIVE_INFINITY
  let maxDif = Number.NEGATIVE_INFINITY
  let tl: Point | null = null
  let br: Point | null = null
  let bl: Point | null = null
  let tr: Point | null = null

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== 1) continue
      const s = x + y
      const d = x - y
      if (s < minSum) {
        minSum = s
        tl = { x, y }
      }
      if (s > maxSum) {
        maxSum = s
        br = { x, y }
      }
      if (d < minDif) {
        minDif = d
        bl = { x, y }
      }
      if (d > maxDif) {
        maxDif = d
        tr = { x, y }
      }
    }
  }
  if (!tl || !tr || !br || !bl) return null
  const w = Math.max(dist(tl, tr), dist(bl, br))
  const h = Math.max(dist(tl, bl), dist(tr, br))
  if (w < MIN_QUAD_WIDTH_PX || h < MIN_QUAD_HEIGHT_PX) return null
  return { tl, tr, br, bl }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Bilinear sample of the source quadrilateral onto an `outW × outH` canvas.
 * The mapping is the standard bilinear-in-(u,v) interpolation of the four
 * corners — the same family as the rotation warp in `plate-deskew.ts`, and
 * exact for the affine case. Out-of-bounds samples clamp to the edge pixel.
 */
export function samplePerspective(
  src: RawRgbImage,
  quad: Quad,
  outW: number,
  outH: number,
): RawRgbImage {
  const { data, width: sw, height: sh, channels: ch } = src
  const out = new Uint8Array(outW * outH * ch)
  const maxX = sw - 1
  const maxY = sh - 1
  // Pixel-CENTRE normalisation: output pixel (ox,oy) samples the quad at
  // ((ox+0.5)/outW, (oy+0.5)/outH). Normalising by outW-1 instead stretches the
  // map by half a pixel per edge, which is enough to shave the first glyph of a
  // 300px strip — it cost two exact reads on the cam-102 ground-truth set.
  for (let oy = 0; oy < outH; oy++) {
    const v = (oy + 0.5) / outH
    for (let ox = 0; ox < outW; ox++) {
      const u = (ox + 0.5) / outW
      const topX = quad.tl.x + (quad.tr.x - quad.tl.x) * u
      const topY = quad.tl.y + (quad.tr.y - quad.tl.y) * u
      const botX = quad.bl.x + (quad.br.x - quad.bl.x) * u
      const botY = quad.bl.y + (quad.br.y - quad.bl.y) * u
      const sx = Math.min(maxX, Math.max(0, topX + (botX - topX) * v))
      const sy = Math.min(maxY, Math.max(0, topY + (botY - topY) * v))
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = x0 < maxX ? x0 + 1 : x0
      const y1 = y0 < maxY ? y0 + 1 : y0
      const fx = sx - x0
      const fy = sy - y0
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx * fy
      const i00 = (y0 * sw + x0) * ch
      const i10 = (y0 * sw + x1) * ch
      const i01 = (y1 * sw + x0) * ch
      const i11 = (y1 * sw + x1) * ch
      const o = (oy * outW + ox) * ch
      for (let k = 0; k < ch; k++) {
        out[o + k] =
          (data[i00 + k]! * w00 +
            data[i10 + k]! * w10 +
            data[i01 + k]! * w01 +
            data[i11 + k]! * w11 +
            0.5) |
          0
      }
    }
  }
  return { data: out, width: outW, height: outH, channels: ch }
}

/** sharp's raw-channel union, narrowed by a guard rather than a cast. */
type SharpChannels = 1 | 2 | 3 | 4

function toSharpChannels(channels: number): SharpChannels {
  switch (channels) {
    case 1:
      return 1
    case 2:
      return 2
    case 4:
      return 4
    default:
      return 3
  }
}

/**
 * Locate the plate blob inside `jpeg` and return it rectified to the canonical
 * {@link PLATE_STRIP_ASPECT} × {@link PLATE_STRIP_HEIGHT} strip.
 *
 * `null` — meaning "caller keeps its own tile" — on: a decode failure, a tile
 * under 16 × 8, no bright component, a component that is a speck or the whole
 * tile, or a quad outside the plate aspect band. Never throws, never returns a
 * strip it is not confident about: the un-warped tile is the floor, not a
 * guess.
 */
export async function warpPlateJpeg(
  jpeg: Buffer,
  opts: { quality?: number } = {},
): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  const raw = await sharp(jpeg)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null)
  if (!raw) return null
  const { data, info } = raw
  if (info.width < 16 || info.height < 8) return null

  const rgb: RawRgbImage = {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    channels: info.channels,
  }
  const gray = toGrayscale(rgb)
  const small = downscaleGray(gray, BLOB_SEARCH_MAX_DIM)
  const scale = small.width / gray.width

  // Otsu, floored at the 55th percentile. Otsu alone splits a tile that is
  // MOSTLY plate too low and lets the blob bleed into the bumper: the plate is
  // the bright MINORITY of a plate ROI, so the threshold must never fall below
  // the tile's own midpoint. Measured: plain Otsu 2/21 exact, this 4/21.
  const threshold = Math.max(otsuThreshold(small), percentile(small, 55))
  const mask = largestBrightComponent(small, threshold)
  if (!mask) return null
  let area = 0
  for (let i = 0; i < mask.length; i++) area += mask[i]!
  const frac = area / (small.width * small.height)
  if (frac < MIN_BLOB_AREA_FRAC || frac > MAX_BLOB_AREA_FRAC) return null

  const q = quadFromMask(mask, small.width, small.height)
  if (!q) return null

  // Back to full-resolution tile coordinates.
  const up = (p: Point): Point => ({ x: p.x / scale, y: p.y / scale })
  const tl = up(q.tl)
  const tr = up(q.tr)
  const br = up(q.br)
  const bl = up(q.bl)
  const quadW = Math.max(dist(tl, tr), dist(bl, br))
  const quadH = Math.max(dist(tl, bl), dist(tr, br))
  if (quadW < MIN_QUAD_WIDTH_PX || quadH < MIN_QUAD_HEIGHT_PX) return null
  const ratio = quadW / quadH
  if (ratio < MIN_QUAD_ASPECT || ratio > MAX_QUAD_ASPECT) return null

  // Inset the left edge along the quad's own top/bottom axes.
  const inset = (a: Point, b: Point): Point => ({
    x: a.x + (b.x - a.x) * LEFT_INSET_FRAC,
    y: a.y + (b.y - a.y) * LEFT_INSET_FRAC,
  })
  const warped: Quad = { tl: inset(tl, tr), tr, br, bl: inset(bl, br) }

  const outH = PLATE_STRIP_HEIGHT
  const outW = Math.round(outH * PLATE_STRIP_ASPECT)
  const strip = samplePerspective(rgb, warped, outW, outH)
  try {
    const outJpeg = await sharp(Buffer.from(strip.data), {
      raw: {
        width: strip.width,
        height: strip.height,
        channels: toSharpChannels(strip.channels),
      },
    })
      .jpeg({ quality: opts.quality ?? 92 })
      .toBuffer()
    return { jpeg: outJpeg, width: strip.width, height: strip.height }
  } catch {
    return null
  }
}
