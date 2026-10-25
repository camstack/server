import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  toGrayscale,
  sobelMagnitude,
  rotateRaw,
  projectionEnergy,
  downscaleGray,
  estimateSkewAngle,
  rectifyPlateJpeg,
  cropLevelledBand,
  MIN_RECTIFY_ANGLE_DEG,
  type GrayImage,
  type RawRgbImage,
} from '../plate-deskew.js'

const DEG2RAD = Math.PI / 180

/**
 * A gray tile of horizontal stripes (period `period` px): a synthetic
 * "text-rows" pattern whose baseline is dead level (0° skew).
 */
function horizontalStripes(width: number, height: number, period = 8): GrayImage {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const v = Math.floor(y / (period / 2)) % 2 === 0 ? 30 : 220
    for (let x = 0; x < width; x++) data[y * width + x] = v
  }
  return { data, width, height }
}

/** Wrap a single-channel gray map as a 1-channel RawRgbImage for rotateRaw. */
function asRaw(gray: GrayImage): RawRgbImage {
  return { data: gray.data, width: gray.width, height: gray.height, channels: 1 }
}

/** Rotate a gray map by `deg` (expand canvas, mid-gray fill) → new gray map. */
function skewGray(gray: GrayImage, deg: number): GrayImage {
  const r = rotateRaw(asRaw(gray), deg * DEG2RAD, { expand: true, fill: 128 })
  return { data: r.data, width: r.width, height: r.height }
}

describe('toGrayscale', () => {
  it('collapses a solid RGB tile to its luma', () => {
    const w = 4
    const h = 4
    const data = new Uint8Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      data[i * 3] = 255 // R
      data[i * 3 + 1] = 255 // G
      data[i * 3 + 2] = 255 // B
    }
    const gray = toGrayscale({ data, width: w, height: h, channels: 3 })
    expect(gray.width).toBe(w)
    expect(gray.height).toBe(h)
    for (const v of gray.data) expect(v).toBeGreaterThanOrEqual(250)
  })
})

describe('sobelMagnitude', () => {
  it('is zero on a flat field and non-zero across an edge', () => {
    const flat: GrayImage = { data: new Uint8Array(6 * 6).fill(120), width: 6, height: 6 }
    const g = sobelMagnitude(flat)
    expect(g.data.every((v) => v === 0)).toBe(true)

    const stripes = horizontalStripes(16, 16, 8)
    const edges = sobelMagnitude(stripes)
    let sum = 0
    for (const v of edges.data) sum += v
    expect(sum).toBeGreaterThan(0)
  })
})

describe('rotateRaw', () => {
  it('is (near) identity at 0°', () => {
    const g = horizontalStripes(20, 20, 8)
    const r = rotateRaw(asRaw(g), 0, { expand: false })
    expect(r.width).toBe(20)
    expect(r.height).toBe(20)
    // Interior pixels unchanged (borders may differ by rounding).
    let maxDiff = 0
    for (let y = 2; y < 18; y++) {
      for (let x = 2; x < 18; x++) {
        const i = y * 20 + x
        maxDiff = Math.max(maxDiff, Math.abs(r.data[i]! - g.data[i]!))
      }
    }
    expect(maxDiff).toBeLessThanOrEqual(1)
  })

  it('expands the canvas to contain the rotated rectangle', () => {
    const g = horizontalStripes(40, 20, 8)
    const r = rotateRaw(asRaw(g), 30 * DEG2RAD, { expand: true, fill: 0 })
    expect(r.width).toBeGreaterThan(40)
    expect(r.height).toBeGreaterThan(20)
  })
})

describe('projectionEnergy', () => {
  it('peaks when a level gradient map is scored flat vs rotated 20°', () => {
    // Score the SAME gradient map at 0° and at 20° (the estimator's own metric):
    // a level (horizontal) text pattern is most peaky at 0°.
    const grad = sobelMagnitude(horizontalStripes(80, 80, 8))
    const flat = projectionEnergy(grad)
    const tilted = rotateRaw(asRaw(grad), 20 * DEG2RAD, { expand: true, fill: 0 })
    const tiltedEnergy = projectionEnergy({
      data: tilted.data,
      width: tilted.width,
      height: tilted.height,
    })
    expect(flat).toBeGreaterThan(tiltedEnergy)
  })
})

describe('downscaleGray', () => {
  it('never upscales and caps the longest side', () => {
    const g = horizontalStripes(30, 20, 8)
    expect(downscaleGray(g, 480)).toBe(g) // already small → returned as-is
    const big = horizontalStripes(960, 480, 16)
    const small = downscaleGray(big, 480)
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(480)
  })
})

describe('estimateSkewAngle', () => {
  it('reports ~0° for already-level stripes', () => {
    const level = horizontalStripes(120, 90, 8)
    const est = estimateSkewAngle(level)
    expect(Math.abs(est.angleDeg)).toBeLessThan(MIN_RECTIFY_ANGLE_DEG)
  })

  it.each([
    -12, -10, -6, 8, 12,
  ])('recovers a known %i° skew as the opposite correction (±2°)', (skewDeg) => {
    // Build a tile skewed by `skewDeg`; the correction that levels it is -skewDeg.
    const level = horizontalStripes(140, 100, 8)
    const skewed = skewGray(level, skewDeg)
    const est = estimateSkewAngle(skewed)
    expect(est.angleDeg).toBeCloseTo(-skewDeg, 0)
    expect(Math.abs(est.angleDeg - -skewDeg)).toBeLessThanOrEqual(2)
  })

  it('returns 0 for a degenerate (too-small) tile', () => {
    const tiny: GrayImage = { data: new Uint8Array(2 * 2), width: 2, height: 2 }
    expect(estimateSkewAngle(tiny).angleDeg).toBe(0)
  })

  /**
   * An optimum ON the sweep boundary is not a measurement — the true maximum
   * lies outside the searched interval and the sweep merely stopped. The live
   * failure: cam-102 plate crops whose profile energy rises monotonically all
   * the way to the negative end, which the old ±30° sweep reported as a
   * confident -27°, warping a readable tile into garbage.
   */
  it('returns 0 when the energy profile is monotone across the whole sweep', () => {
    // A single steep diagonal band (-40°): the correction that levels it is far
    // outside the declared regime, so the profile only ever climbs toward +max.
    const w = 140
    const h = 100
    const data = new Uint8Array(w * h).fill(200)
    const slope = Math.tan(-40 * DEG2RAD)
    for (let x = 0; x < w; x++) {
      const yc = h / 2 + slope * (x - w / 2)
      for (let dy = -4; dy <= 4; dy++) {
        const y = Math.round(yc + dy)
        if (y >= 0 && y < h) data[y * w + x] = 30
      }
    }
    expect(estimateSkewAngle({ data, width: w, height: h }).angleDeg).toBe(0)
  })

  it('never searches past the declared ±15° CTC regime', () => {
    // A 25° skew is out of regime: report 0 (leave the tile alone) rather than
    // a boundary-clamped angle that would warp it.
    const skewed = skewGray(horizontalStripes(140, 100, 8), 25)
    expect(estimateSkewAngle(skewed).angleDeg).toBe(0)
  })
})

/** Encode a gray map as a 3-channel JPEG buffer (the shape the executor feeds). */
async function grayToJpeg(gray: GrayImage): Promise<Buffer> {
  const rgb = new Uint8Array(gray.width * gray.height * 3)
  for (let i = 0; i < gray.data.length; i++) {
    rgb[i * 3] = gray.data[i]!
    rgb[i * 3 + 1] = gray.data[i]!
    rgb[i * 3 + 2] = gray.data[i]!
  }
  return sharp(Buffer.from(rgb), { raw: { width: gray.width, height: gray.height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer()
}

describe('rectifyPlateJpeg', () => {
  it('returns null (no warp) for an already-level plate crop', async () => {
    const jpeg = await grayToJpeg(horizontalStripes(160, 100, 8))
    expect(await rectifyPlateJpeg(jpeg)).toBeNull()
  })

  it('deskews a steeply-skewed crop and reports the correction angle', async () => {
    // 12°, not 16: the sweep now stops at ±16 and rejects any optimum within a
    // coarse step of that edge, so a 16° skew is (correctly) reported as
    // unmeasured. 12° is the top of the regime the warp is allowed to act on.
    const skewDeg = 12
    const jpeg = await grayToJpeg(skewGray(horizontalStripes(180, 120, 8), skewDeg))
    const out = await rectifyPlateJpeg(jpeg)
    expect(out).not.toBeNull()
    expect(Math.abs(out!.angleDeg)).toBeGreaterThanOrEqual(MIN_RECTIFY_ANGLE_DEG)
    // Correction levels the skew: within ±3° of -skewDeg (jpeg round-trip adds noise).
    expect(Math.abs(out!.angleDeg - -skewDeg)).toBeLessThanOrEqual(3)
    const meta = await sharp(out!.jpeg).metadata()
    expect(meta.width).toBeGreaterThan(0)
    expect(meta.height).toBeGreaterThan(0)
  })

  it('returns null for an undecodable buffer', async () => {
    expect(await rectifyPlateJpeg(Buffer.from([1, 2, 3, 4]))).toBeNull()
  })

  /**
   * The warp must not hand OCR the expanded canvas. `rotateRaw(expand: true)`
   * grows the tile to contain the rotated rectangle, so a 155px-tall crop comes
   * back 194px tall — ~40px of flat fill above and below the text. The
   * recognizer resizes the whole tile to a fixed 64px height, so that padding
   * shrinks the glyphs it has to read.
   */
  it('never returns a tile TALLER than the crop it was given', async () => {
    const skewed = skewGray(horizontalStripes(180, 120, 8), 12)
    const jpeg = await grayToJpeg(skewed)
    const out = await rectifyPlateJpeg(jpeg)
    expect(out).not.toBeNull()
    expect(out!.height).toBeLessThan(skewed.height)
    // The levelled band is the source rectangle shrunk by cos(angle).
    expect(out!.height).toBeCloseTo(skewed.height * Math.cos(out!.angleDeg * DEG2RAD), -1)
  })
})

describe('cropLevelledBand', () => {
  it('cuts the expanded canvas back to the levelled source rectangle', () => {
    const w = 200
    const h = 60
    const deg = 20
    const src: RawRgbImage = {
      data: new Uint8Array(w * h * 3).fill(128),
      width: w,
      height: h,
      channels: 3,
    }
    const rotated = rotateRaw(src, deg * DEG2RAD, { expand: true, fill: 0 })
    // The expanded canvas is ~125 tall — twice the source band.
    expect(rotated.height).toBeGreaterThan(120)

    const band = cropLevelledBand(rotated, w, h, deg * DEG2RAD)
    expect(band.height).toBeCloseTo(h * Math.cos(deg * DEG2RAD), 0)
    expect(band.width).toBeCloseTo(w * Math.cos(deg * DEG2RAD), 0)
    expect(band.channels).toBe(3)
    expect(band.data.length).toBe(band.width * band.height * 3)
  })

  it('is a no-op at 0° (nothing to trim)', () => {
    const src: RawRgbImage = {
      data: new Uint8Array(40 * 20 * 3).fill(7),
      width: 40,
      height: 20,
      channels: 3,
    }
    const band = cropLevelledBand(src, 40, 20, 0)
    expect(band.width).toBe(40)
    expect(band.height).toBe(20)
  })
})
