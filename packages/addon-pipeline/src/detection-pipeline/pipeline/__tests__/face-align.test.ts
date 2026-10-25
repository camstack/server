import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  ARCFACE_TEMPLATE_112,
  computeSimilarityTransform,
  invertSimilarity,
  applySimilarity,
  warpToTemplate,
  bboxShortSide,
  alignFaceCrop,
  type Pt,
  type RawImage,
} from '../face-align.js'

const tpl = ARCFACE_TEMPLATE_112

describe('computeSimilarityTransform', () => {
  it('recovers the identity when src === dst', () => {
    const t = computeSimilarityTransform(tpl, tpl)
    expect(t.a).toBeCloseTo(1, 6)
    expect(t.b).toBeCloseTo(0, 6)
    expect(t.tx).toBeCloseTo(0, 4)
    expect(t.ty).toBeCloseTo(0, 4)
  })

  it('recovers a pure translation', () => {
    const dst = tpl.map((p) => ({ x: p.x + 12, y: p.y - 7 }))
    const t = computeSimilarityTransform(tpl, dst)
    expect(t.a).toBeCloseTo(1, 6)
    expect(t.b).toBeCloseTo(0, 6)
    expect(t.tx).toBeCloseTo(12, 4)
    expect(t.ty).toBeCloseTo(-7, 4)
  })

  it('recovers an exact scale + rotation + translation', () => {
    const known = { a: 2 * Math.cos(Math.PI / 6), b: 2 * Math.sin(Math.PI / 6), tx: 5, ty: 7 }
    const dst = tpl.map((p) => applySimilarity(known, p))
    const t = computeSimilarityTransform(tpl, dst)
    expect(t.a).toBeCloseTo(known.a, 5)
    expect(t.b).toBeCloseTo(known.b, 5)
    expect(t.tx).toBeCloseTo(known.tx, 4)
    expect(t.ty).toBeCloseTo(known.ty, 4)
  })

  it('throws on degenerate (coincident) source points', () => {
    const same: Pt[] = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ]
    expect(() => computeSimilarityTransform(same, tpl.slice(0, 3))).toThrow(/degenerate/)
  })
})

describe('invertSimilarity', () => {
  it('round-trips a point through forward then inverse', () => {
    const fwd = { a: 1.5 * Math.cos(0.4), b: 1.5 * Math.sin(0.4), tx: 30, ty: -12 }
    const inv = invertSimilarity(fwd)
    for (const p of [
      { x: 0, y: 0 },
      { x: 50, y: 80 },
      { x: -20, y: 33 },
    ]) {
      const back = applySimilarity(inv, applySimilarity(fwd, p))
      expect(back.x).toBeCloseTo(p.x, 4)
      expect(back.y).toBeCloseTo(p.y, 4)
    }
  })
})

/** Build a raw RGB image whose colour encodes pixel coordinates. */
function gradient(width: number, height: number): RawImage {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      data[i] = x % 256
      data[i + 1] = y % 256
      data[i + 2] = 100
    }
  }
  return { data, width, height, channels: 3 }
}

function px(img: RawImage, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * img.channels
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]
}

describe('warpToTemplate', () => {
  it('is a no-op crop when landmarks already equal the template', () => {
    const src = gradient(112, 112)
    const out = warpToTemplate(src, tpl, tpl, 112)
    expect(out.width).toBe(112)
    expect(out.height).toBe(112)
    for (const [x, y] of [
      [10, 10],
      [50, 80],
      [100, 30],
    ] as const) {
      expect(px(out, x, y)).toEqual(px(src, x, y))
    }
  })

  it('samples the translated source when landmarks are offset', () => {
    const src = gradient(140, 140)
    const landmarks = tpl.map((p) => ({ x: p.x + 10, y: p.y + 10 })) // src = template + 10
    const out = warpToTemplate(src, landmarks, tpl, 112)
    // output(ox,oy) should sample src(ox+10, oy+10)
    for (const [ox, oy] of [
      [20, 30],
      [60, 70],
      [0, 0],
    ] as const) {
      const [r, g] = px(out, ox, oy)
      expect(r).toBeCloseTo(ox + 10, -0.4) // channel0 encodes source x
      expect(g).toBeCloseTo(oy + 10, -0.4) // channel1 encodes source y
    }
  })
})

describe('bboxShortSide', () => {
  it('returns the smaller of width/height', () => {
    expect(bboxShortSide([0, 0, 100, 40])).toBe(40)
    expect(bboxShortSide([10, 10, 30, 200])).toBe(20)
  })
})

describe('alignFaceCrop (integration with sharp)', () => {
  it('produces a valid 112x112 JPEG from a full-frame JPEG + landmarks', async () => {
    const frame = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 20, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer()

    // A plausible face bbox around the centre with landmarks inside it.
    const bbox = [120, 80, 200, 170] as const
    const landmarks: Pt[] = [
      { x: 140, y: 110 }, // left eye
      { x: 180, y: 110 }, // right eye
      { x: 160, y: 130 }, // nose
      { x: 145, y: 150 }, // left mouth
      { x: 175, y: 150 }, // right mouth
    ]
    const { jpeg, width, height } = await alignFaceCrop(frame, bbox, landmarks, 320, 240)
    expect(width).toBe(112)
    expect(height).toBe(112)
    const meta = await sharp(jpeg).metadata()
    expect(meta.width).toBe(112)
    expect(meta.height).toBe(112)
    expect(meta.format).toBe('jpeg')
  })
})
