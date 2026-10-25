/**
 * Plate-crop DESKEW — rotation rectification for oblique licence-plate crops.
 *
 * Plate crops reach the CTC recognizer as an axis-aligned bbox tile with NO
 * geometric correction. On steeply oblique cameras (cam 102) the plate text is
 * skewed, and CTC collapses beyond ~10-15° of baseline tilt. This module
 * estimates the plate's dominant rotation from the crop ALONE (no plate quad is
 * available) and rotates the tile so the text baseline is horizontal before OCR.
 *
 * Approach (classic projection-profile deskew, pure TS — no OpenCV, no new
 * native deps; sharp is used only to decode/encode JPEG, mirroring the sibling
 * `native-child-crop.ts` / `face-align.ts`):
 *   1. grayscale → isotropic Sobel gradient magnitude (an orientation-agnostic
 *      "ink/edge" map, robust to plate polarity and lighting).
 *   2. for a small set of candidate CORRECTION angles, rotate the gradient map
 *      (bilinear, same primitive family as the face warp) and score the
 *      horizontal projection profile by its energy `Σ rowSum²`. That energy is
 *      MAXIMISED when the text edges land on horizontal rows — the profile is
 *      peaky (a few high rows) rather than smeared across many rows.
 *   3. pick the angle maximising the score (coarse 2° sweep + a 0.5° local
 *      refinement); apply it to the full-resolution RGB tile only when it is
 *      meaningfully non-zero AND the optimum was BRACKETED by the sweep — an
 *      argmax sitting on the boundary means the profile never turned over and
 *      the "angle" is an artefact of where the search stopped.
 *
 * All of the geometry is pure functions over raw buffers, so the estimator is
 * fully deterministic and unit-testable without any image I/O.
 */
import sharp from 'sharp'

export interface GrayImage {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

export interface RawRgbImage {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  readonly channels: number
}

/** Options for {@link estimateSkewAngle}. All in degrees. */
export interface SkewEstimateOptions {
  /** Max absolute correction angle searched (± this). Default {@link DEFAULT_MAX_ANGLE_DEG}. */
  readonly maxAngleDeg?: number
  /** Coarse sweep step. Default 2. */
  readonly coarseStepDeg?: number
  /** Local refinement step around the coarse best. Default 0.5. */
  readonly fineStepDeg?: number
  /** Longest side used for scoring; the map is downscaled to fit. Default 480. */
  readonly scoreMaxDim?: number
}

export interface SkewEstimate {
  /** Correction angle (deg): rotate the crop by THIS to level the text. */
  readonly angleDeg: number
  /** Projection-profile energy of the winning angle (relative score). */
  readonly score: number
}

const DEG2RAD = Math.PI / 180

/** Convert an interleaved RGB/RGBA buffer to single-channel luma. */
export function toGrayscale(rgb: RawRgbImage): GrayImage {
  const { data, width, height, channels } = rgb
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += channels) {
    // Rec.601 luma — integer-friendly weights.
    out[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8
  }
  return { data: out, width, height }
}

/**
 * Isotropic Sobel gradient magnitude of a grayscale image, clamped to [0,255].
 * Border pixels are 0 (no valid 3×3 neighbourhood) — they carry no baseline
 * signal anyway. The magnitude is polarity-agnostic, so it responds to both
 * dark-on-light and light-on-dark plates.
 */
export function sobelMagnitude(gray: GrayImage): GrayImage {
  const { data, width, height } = gray
  const out = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const tl = data[i - width - 1]!
      const tc = data[i - width]!
      const tr = data[i - width + 1]!
      const ml = data[i - 1]!
      const mr = data[i + 1]!
      const bl = data[i + width - 1]!
      const bc = data[i + width]!
      const br = data[i + width + 1]!
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl)
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr)
      const mag = Math.sqrt(gx * gx + gy * gy)
      out[i] = mag > 255 ? 255 : mag
    }
  }
  return { data: out, width, height }
}

/**
 * Rotate a raw image (any channel count) about its centre by `angleRad`
 * (positive = counter-clockwise) using bilinear interpolation — the same
 * resampling family as the face-alignment warp. When `expand` is true the
 * output canvas grows to contain the whole rotated rectangle (no corner
 * clipping); otherwise it keeps the source dimensions. Out-of-bounds samples
 * take the `fill` value (default 0), so an expanded canvas gets a flat border.
 */
export function rotateRaw(
  src: RawRgbImage,
  angleRad: number,
  opts: { expand?: boolean; fill?: number } = {},
): RawRgbImage {
  const { data, width: w, height: h, channels: ch } = src
  const expand = opts.expand ?? false
  const fill = opts.fill ?? 0
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)

  let ow = w
  let oh = h
  if (expand) {
    ow = Math.max(1, Math.ceil(Math.abs(w * c) + Math.abs(h * s)))
    oh = Math.max(1, Math.ceil(Math.abs(w * s) + Math.abs(h * c)))
  }

  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const ocx = (ow - 1) / 2
  const ocy = (oh - 1) / 2
  const out = new Uint8Array(ow * oh * ch)
  const maxX = w - 1
  const maxY = h - 1

  for (let oy = 0; oy < oh; oy++) {
    const dyo = oy - ocy
    for (let ox = 0; ox < ow; ox++) {
      const dxo = ox - ocx
      // source = R(-angle) · output-relative  (inverse map)
      const sx = c * dxo + s * dyo + cx
      const sy = -s * dxo + c * dyo + cy
      const o = (oy * ow + ox) * ch
      if (sx < 0 || sx > maxX || sy < 0 || sy > maxY) {
        for (let k = 0; k < ch; k++) out[o + k] = fill
        continue
      }
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
      const i00 = (y0 * w + x0) * ch
      const i10 = (y0 * w + x1) * ch
      const i01 = (y1 * w + x0) * ch
      const i11 = (y1 * w + x1) * ch
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
  return { data: out, width: ow, height: oh, channels: ch }
}

/**
 * Horizontal-projection-profile ENERGY of a single-channel map: `Σ_row rowSum²`.
 * Higher when the map's mass is concentrated in a few rows (aligned text) rather
 * than smeared across many (skewed text). Total mass is ~conserved by the
 * bilinear rotation, so this energy cleanly ranks candidate rotations.
 */
export function projectionEnergy(gray: GrayImage): number {
  const { data, width, height } = gray
  let energy = 0
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    const base = y * width
    for (let x = 0; x < width; x++) rowSum += data[base + x]!
    energy += rowSum * rowSum
  }
  return energy
}

/** Area-average downscale of a gray map so its longest side ≤ `maxDim` (never upscales). */
export function downscaleGray(gray: GrayImage, maxDim: number): GrayImage {
  const { data, width, height } = gray
  const longest = Math.max(width, height)
  if (longest <= maxDim) return gray
  const scale = maxDim / longest
  const nw = Math.max(1, Math.round(width * scale))
  const nh = Math.max(1, Math.round(height * scale))
  const out = new Uint8Array(nw * nh)
  const fx = width / nw
  const fy = height / nh
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y * fy)
    const sy1 = Math.min(height, Math.floor((y + 1) * fy))
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x * fx)
      const sx1 = Math.min(width, Math.floor((x + 1) * fx))
      let sum = 0
      let n = 0
      for (let yy = sy0; yy < Math.max(sy0 + 1, sy1); yy++) {
        const base = yy * width
        for (let xx = sx0; xx < Math.max(sx0 + 1, sx1); xx++) {
          sum += data[base + xx]!
          n++
        }
      }
      out[y * nw + x] = n > 0 ? (sum / n) | 0 : 0
    }
  }
  return { data: out, width: nw, height: nh }
}

/** Score one correction angle: rotate the gradient map and take its profile energy. */
function scoreAngle(gradient: GrayImage, angleRad: number): number {
  if (angleRad === 0) return projectionEnergy(gradient)
  const rotated = rotateRaw(
    { data: gradient.data, width: gradient.width, height: gradient.height, channels: 1 },
    angleRad,
    { expand: true, fill: 0 },
  )
  return projectionEnergy({ data: rotated.data, width: rotated.width, height: rotated.height })
}

/**
 * Widest correction the sweep searches (±). The module's whole reason to exist
 * is the CTC regime declared at the top of this file — the recognizer collapses
 * beyond ~10-15° of baseline tilt — so searching further buys nothing a warp
 * could rescue, and it BUYS a failure mode: with a ±30° sweep the profile
 * energy of a real cam-102 crop rose monotonically all the way to the negative
 * end and the estimator reported a confident -27°, warping a legible tile into
 * garbage (0/11 exact reads live, 2026-08). The extra `coarseStepDeg` past the
 * declared 15° is the rejection band below — it keeps {@link BOUNDARY_REJECT_DEG}
 * from eating the top of the usable range.
 */
export const DEFAULT_MAX_ANGLE_DEG = 16
const DEFAULT_COARSE_STEP_DEG = 2

/**
 * An optimum this close to (or past) the sweep edge is REJECTED as unmeasured:
 * the profile is still climbing when the search stops, so the real maximum lies
 * outside the interval and the reported angle is an artefact of where we chose
 * to stop looking. A monotone profile — the live cam-102 case — always lands
 * here, since a monotone sequence's argmax IS an endpoint.
 */
const BOUNDARY_REJECT_DEG = DEFAULT_MAX_ANGLE_DEG - DEFAULT_COARSE_STEP_DEG

const NO_SKEW: SkewEstimate = { angleDeg: 0, score: 0 }

/**
 * Estimate the dominant text-baseline skew of a grayscale plate crop and return
 * the CORRECTION angle (degrees) that levels it. A coarse sweep over
 * ±`maxAngleDeg` in `coarseStepDeg` steps finds the best bucket; a `fineStepDeg`
 * local search refines it. Returns `0` when the flat (no-rotation) profile is
 * already the strongest response, and — critically — also when the coarse
 * winner is not BRACKETED by the sweep (see {@link BOUNDARY_REJECT_DEG}): an
 * optimum sitting on the edge of the searched interval is not a measurement,
 * it is the place the search ran out of road.
 */
export function estimateSkewAngle(gray: GrayImage, opts: SkewEstimateOptions = {}): SkewEstimate {
  const maxAngleDeg = opts.maxAngleDeg ?? DEFAULT_MAX_ANGLE_DEG
  const coarseStepDeg = opts.coarseStepDeg ?? DEFAULT_COARSE_STEP_DEG
  const fineStepDeg = opts.fineStepDeg ?? 0.5
  const scoreMaxDim = opts.scoreMaxDim ?? 480
  const boundaryRejectDeg = Math.max(0, maxAngleDeg - coarseStepDeg)

  if (gray.width < 4 || gray.height < 4) return NO_SKEW

  const small = downscaleGray(gray, scoreMaxDim)
  const gradient = sobelMagnitude(small)

  let bestAngle = 0
  let bestScore = scoreAngle(gradient, 0)

  for (let deg = -maxAngleDeg; deg <= maxAngleDeg + 1e-9; deg += coarseStepDeg) {
    if (deg === 0) continue
    const score = scoreAngle(gradient, deg * DEG2RAD)
    if (score > bestScore) {
      bestScore = score
      bestAngle = deg
    }
  }

  // The coarse optimum must be bracketed by the sweep. When it is not, the
  // profile never turned over inside the interval — there is no measured
  // baseline here, only the edge of the search. Report "no skew" so the caller
  // keeps the untouched tile (D-plate: never warp on an unmeasured angle).
  if (Math.abs(bestAngle) >= boundaryRejectDeg) return NO_SKEW

  // Local refinement around the coarse winner.
  const lo = bestAngle - coarseStepDeg
  const hi = bestAngle + coarseStepDeg
  for (let deg = lo; deg <= hi + 1e-9; deg += fineStepDeg) {
    if (deg < -maxAngleDeg || deg > maxAngleDeg) continue
    const score = scoreAngle(gradient, deg * DEG2RAD)
    if (score > bestScore) {
      bestScore = score
      bestAngle = deg
    }
  }

  return { angleDeg: bestAngle, score: bestScore }
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
 * Cut an expand-rotated canvas back to the LEVELLED SOURCE BAND.
 *
 * `rotateRaw(expand: true)` grows the canvas to `w·|cos| + h·|sin|` ×
 * `w·|sin| + h·|cos|` so no corner is clipped — but the `|sin|` terms are pure
 * corner spread: flat fill above/below (and left/right of) the plate. Handing
 * that to OCR is not free. The recognizer letterboxes the whole tile into a
 * fixed 64px-tall input, so a 155px crop returned at 194px shrinks every glyph
 * by ~20% before a single character is read — the warp paying back part of what
 * it just won.
 *
 * The band kept is the source rectangle scaled by `|cos angle|`, centred: a
 * source edge of length L, once levelled, spans `L·|cos|` along its own axis.
 * Everything outside is the fill the rotation introduced.
 */
export function cropLevelledBand(
  rotated: RawRgbImage,
  srcWidth: number,
  srcHeight: number,
  angleRad: number,
): RawRgbImage {
  const c = Math.abs(Math.cos(angleRad))
  const bw = Math.max(1, Math.min(rotated.width, Math.round(srcWidth * c)))
  const bh = Math.max(1, Math.min(rotated.height, Math.round(srcHeight * c)))
  if (bw === rotated.width && bh === rotated.height) return rotated

  const ch = rotated.channels
  const x0 = Math.max(0, Math.floor((rotated.width - bw) / 2))
  const y0 = Math.max(0, Math.floor((rotated.height - bh) / 2))
  const out = new Uint8Array(bw * bh * ch)
  const rowBytes = bw * ch
  for (let y = 0; y < bh; y++) {
    const srcOff = ((y0 + y) * rotated.width + x0) * ch
    out.set(rotated.data.subarray(srcOff, srcOff + rowBytes), y * rowBytes)
  }
  return { data: out, width: bw, height: bh, channels: ch }
}

/** Minimum |correction| (deg) worth a warp — below this the crop is effectively level. */
export const MIN_RECTIFY_ANGLE_DEG = 2

/**
 * Rectify an oblique plate crop: decode the JPEG, estimate the baseline skew,
 * and — only when it exceeds {@link MIN_RECTIFY_ANGLE_DEG} — rotate the
 * full-resolution RGB tile to level the text and re-encode. Returns `null` when
 * no meaningful rotation is needed (caller keeps the original tile) or on any
 * decode/degenerate failure (never worse than the un-rectified input).
 *
 * The returned `angleDeg` is the applied correction (0 is never returned with a
 * jpeg — a null means "unchanged").
 */
export async function rectifyPlateJpeg(
  jpeg: Buffer,
  opts: SkewEstimateOptions & { quality?: number } = {},
): Promise<{ jpeg: Buffer; width: number; height: number; angleDeg: number } | null> {
  const raw = await sharp(jpeg)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null)
  if (!raw) return null
  const { data, info } = raw
  if (info.width < 4 || info.height < 4) return null

  const rgb: RawRgbImage = {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    channels: info.channels,
  }
  const gray = toGrayscale(rgb)
  const { angleDeg } = estimateSkewAngle(gray, opts)
  if (Math.abs(angleDeg) < MIN_RECTIFY_ANGLE_DEG) return null

  // Fill the expanded corners with the tile's mean luma so OCR sees a neutral
  // border rather than a hard black edge that could be mistaken for a glyph.
  let mean = 0
  for (let i = 0; i < gray.data.length; i++) mean += gray.data[i]!
  const fill = gray.data.length > 0 ? (mean / gray.data.length) | 0 : 0

  const angleRad = angleDeg * DEG2RAD
  const band = cropLevelledBand(
    rotateRaw(rgb, angleRad, { expand: true, fill }),
    rgb.width,
    rgb.height,
    angleRad,
  )
  try {
    const outJpeg = await sharp(Buffer.from(band.data), {
      raw: {
        width: band.width,
        height: band.height,
        channels: toSharpChannels(band.channels),
      },
    })
      .jpeg({ quality: opts.quality ?? 90 })
      .toBuffer()
    return { jpeg: outJpeg, width: band.width, height: band.height, angleDeg }
  } catch {
    return null
  }
}
