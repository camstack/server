import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  otsuThreshold,
  largestBrightComponent,
  quadFromMask,
  samplePerspective,
  warpPlateJpeg,
  PLATE_STRIP_ASPECT,
  PLATE_STRIP_HEIGHT,
  type Quad,
} from '../plate-warp.js'
import type { GrayImage, RawRgbImage } from '../plate-deskew.js'

/** Bimodal gray tile: `frac` of the pixels dark (40), the rest bright (210). */
function bimodal(width: number, height: number, frac: number): GrayImage {
  const data = new Uint8Array(width * height)
  const cut = Math.round(width * height * frac)
  for (let i = 0; i < data.length; i++) data[i] = i < cut ? 40 : 210
  return { data, width, height }
}

/** A dark tile with one bright axis-aligned rectangle. */
function brightRect(
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): GrayImage {
  const data = new Uint8Array(width * height).fill(30)
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) data[y * width + x] = 220
  }
  return { data, width, height }
}

function maskOfRect(
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): Uint8Array {
  const m = new Uint8Array(width * height)
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) m[y * width + x] = 1
  }
  return m
}

/** Solid RGB canvas with a bright quadrilateral painted on it (scanline fill). */
function rgbWithQuad(width: number, height: number, quad: Quad, value = 235): RawRgbImage {
  const data = new Uint8Array(width * height * 3).fill(25)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pointInQuad(x + 0.5, y + 0.5, quad)) {
        const o = (y * width + x) * 3
        data[o] = value
        data[o + 1] = value
        data[o + 2] = value
      }
    }
  }
  return { data, width, height, channels: 3 }
}

function pointInQuad(px: number, py: number, q: Quad): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let inside = false
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = pts[i]!
    const b = pts[j]!
    const hit = a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x
    if (hit) inside = !inside
  }
  return inside
}

describe('otsuThreshold', () => {
  it('lands between the two modes of a bimodal tile', () => {
    // Otsu returns the LEVEL, and "bright" is strictly above it: the whole
    // [dark, bright) band is an optimum, so assert separation, not a midpoint.
    const t = otsuThreshold(bimodal(40, 40, 0.5))
    expect(t).toBeGreaterThanOrEqual(40)
    expect(t).toBeLessThan(210)
  })

  it('is deterministic for a flat tile (no crash, in range)', () => {
    const flat: GrayImage = { data: new Uint8Array(100).fill(128), width: 10, height: 10 }
    const t = otsuThreshold(flat)
    expect(Number.isFinite(t)).toBe(true)
    expect(t).toBeGreaterThanOrEqual(0)
    expect(t).toBeLessThanOrEqual(255)
  })
})

describe('largestBrightComponent', () => {
  it('keeps the big rectangle and drops a small bright speck', () => {
    const g = brightRect(60, 40, { x: 10, y: 10, w: 30, h: 16 })
    // speck
    g.data[2 * 60 + 2] = 240
    const mask = largestBrightComponent(g, 128)
    expect(mask).not.toBeNull()
    expect(mask![10 * 60 + 12]).toBe(1) // inside the rectangle
    expect(mask![2 * 60 + 2]).toBe(0) // the speck lost
  })

  it('returns null when nothing is above the threshold', () => {
    const g: GrayImage = { data: new Uint8Array(400).fill(20), width: 20, height: 20 }
    expect(largestBrightComponent(g, 200)).toBeNull()
  })
})

describe('quadFromMask', () => {
  it('recovers the corners of an axis-aligned rectangle', () => {
    const rect = { x: 8, y: 6, w: 40, h: 12 }
    const q = quadFromMask(maskOfRect(64, 32, rect), 64, 32)
    expect(q).not.toBeNull()
    expect(q!.tl.x).toBeCloseTo(rect.x, 0)
    expect(q!.tl.y).toBeCloseTo(rect.y, 0)
    expect(q!.br.x).toBeCloseTo(rect.x + rect.w - 1, 0)
    expect(q!.br.y).toBeCloseTo(rect.y + rect.h - 1, 0)
  })

  it('returns null for a degenerate (too small) mask', () => {
    const m = new Uint8Array(64 * 32)
    m[0] = 1
    expect(quadFromMask(m, 64, 32)).toBeNull()
  })
})

describe('samplePerspective', () => {
  it('maps the quad onto the full output rectangle', () => {
    // 40x20 bright block inside a 60x40 dark canvas, sampled back to 20x10.
    const quad: Quad = {
      tl: { x: 10, y: 10 },
      tr: { x: 49, y: 10 },
      br: { x: 49, y: 29 },
      bl: { x: 10, y: 29 },
    }
    const src = rgbWithQuad(60, 40, quad)
    // Sample one pixel inside the painted block on every side — the polygon
    // fill excludes its own boundary, so the quad's outermost row/column is
    // half-covered and would bleed the background in.
    const inner: Quad = {
      tl: { x: quad.tl.x + 1, y: quad.tl.y + 1 },
      tr: { x: quad.tr.x - 1, y: quad.tr.y + 1 },
      br: { x: quad.br.x - 1, y: quad.br.y - 1 },
      bl: { x: quad.bl.x + 1, y: quad.bl.y - 1 },
    }
    const out = samplePerspective(src, inner, 20, 10)
    expect(out.width).toBe(20)
    expect(out.height).toBe(10)
    // every output pixel came from inside the bright block
    let dark = 0
    for (let i = 0; i < out.data.length; i += 3) if (out.data[i]! < 100) dark++
    expect(dark).toBe(0)
  })
})

describe('warpPlateJpeg', () => {
  /** An oblique bright plate-shaped quad on a dark background. */
  async function obliquePlateJpeg(): Promise<Buffer> {
    const quad: Quad = {
      tl: { x: 14, y: 30 },
      tr: { x: 150, y: 8 },
      br: { x: 150, y: 40 },
      bl: { x: 14, y: 62 },
    }
    const rgb = rgbWithQuad(180, 80, quad)
    return sharp(Buffer.from(rgb.data), {
      raw: { width: rgb.width, height: rgb.height, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .toBuffer()
  }

  it('returns a canonical strip: fixed height, aspect-locked width', async () => {
    const res = await warpPlateJpeg(await obliquePlateJpeg())
    expect(res).not.toBeNull()
    expect(res!.height).toBe(PLATE_STRIP_HEIGHT)
    expect(res!.width).toBe(Math.round(PLATE_STRIP_HEIGHT * PLATE_STRIP_ASPECT))
  })

  it('levels the oblique plate — the strip is bright edge to edge', async () => {
    const res = await warpPlateJpeg(await obliquePlateJpeg())
    const raw = await sharp(res!.jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const { data, info } = raw
    // sample the middle row: an unlevelled crop would still carry dark corners
    const y = Math.floor(info.height / 2)
    let dark = 0
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels]! < 90) dark++
    }
    expect(dark).toBeLessThan(info.width * 0.1)
  })

  it('returns null when no plausible plate blob is present', async () => {
    const flat = await sharp({
      create: { width: 120, height: 60, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .jpeg()
      .toBuffer()
    expect(await warpPlateJpeg(flat)).toBeNull()
  })

  it('returns null on a degenerate tile instead of throwing', async () => {
    const tiny = await sharp({
      create: { width: 3, height: 3, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer()
    expect(await warpPlateJpeg(tiny)).toBeNull()
  })
})
