/**
 * The runner half of the v2 descriptor (D683 §8.1). Pure pixel arithmetic on
 * a small RGB view; no model, no weights.
 *
 * Disarms (each alone, restored):
 *  - compute `gray` as always `false`: "a greyscale view is gray" fails;
 *  - judge `gray` on plain mean saturation (not saturation × value): "dark IR
 *    noise reads as gray" fails (review M9: near-black noise has a high HSV
 *    saturation — (3,1,2) is s = 0.67 — but carries no colour).
 */
import { APPEARANCE_BIN_COUNT, APPEARANCE_BLOCKS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  appearanceCrop,
  computeAppearanceDescriptor,
  type RgbView,
} from '../appearance-descriptor.js'

function view(
  w: number,
  h: number,
  px: (x: number, y: number) => readonly [number, number, number],
): RgbView {
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y)
      const i = (y * w + x) * 3
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
  }
  return { data, width: w, height: h }
}

function block(bins: readonly number[], name: keyof typeof APPEARANCE_BLOCKS): readonly number[] {
  const [from, to] = APPEARANCE_BLOCKS[name]
  return bins.slice(from, to)
}

describe('computeAppearanceDescriptor', () => {
  it('has the declared layout and version', () => {
    const d = computeAppearanceDescriptor(view(16, 32, () => [200, 30, 30]))
    expect(d.version).toBe(1)
    expect(d.bins).toHaveLength(APPEARANCE_BIN_COUNT)
  })

  it('a saturated red view puts all hue–saturation mass in the red, high-saturation bin', () => {
    const d = computeAppearanceDescriptor(view(16, 32, () => [230, 10, 10]))
    const hs = block(d.bins, 'upperHs')
    expect(hs[0 * 4 + 3]).toBe(255)
    expect(hs.reduce((a, b) => a + b, 0)).toBe(255)
    expect(d.gray).toBe(false)
  })

  it('a greyscale view is gray', () => {
    expect(computeAppearanceDescriptor(view(16, 32, (x) => [x * 10, x * 10, x * 10])).gray).toBe(
      true,
    )
  })

  it('dark IR noise reads as gray', () => {
    expect(
      computeAppearanceDescriptor(view(16, 32, (x) => (x % 2 === 0 ? [3, 1, 2] : [2, 3, 1]))).gray,
    ).toBe(true)
  })

  it('separates a red top from a blue bottom', () => {
    const d = computeAppearanceDescriptor(
      view(16, 32, (_x, y) => (y < 16 ? [230, 10, 10] : [10, 10, 230])),
    )
    expect(block(d.bins, 'upperHs')).not.toEqual(block(d.bins, 'lowerHs'))
  })

  it('vertical stripes put gradient mass in the horizontal-gradient bin', () => {
    // Two-pixel stripes: the central difference across a column is ±255, never 0.
    const d = computeAppearanceDescriptor(
      view(16, 32, (x) => (x % 4 < 2 ? [0, 0, 0] : [255, 255, 255])),
    )
    const g = block(d.bins, 'upperGrad')
    expect(g[0]).toBe(Math.max(...g))
  })
})

describe('appearanceCrop', () => {
  it('shrinks 10 % per side and clamps to the frame', () => {
    expect(
      appearanceCrop({ x: 100, y: 100, width: 200, height: 400 }, { width: 640, height: 360 }),
    ).toEqual({
      left: 120,
      top: 140,
      width: 160,
      height: 220,
    })
  })

  it('refuses a box too small to describe', () => {
    expect(
      appearanceCrop({ x: 10, y: 10, width: 4, height: 4 }, { width: 640, height: 360 }),
    ).toBeNull()
  })

  it('clamps a box whose origin sits off-frame (a box edge past 0,0)', () => {
    // Shrink-only math would put left/top at -30; the box edge is off-frame,
    // and the crop must clamp to the frame origin, not go negative.
    expect(
      appearanceCrop({ x: -50, y: -50, width: 200, height: 200 }, { width: 640, height: 360 }),
    ).toEqual({
      left: 0,
      top: 0,
      width: 130,
      height: 130,
    })
  })

  it('clips a box extending past the frame border', () => {
    // The far edge (720, 340) is outside the 640×360 frame; the crop must
    // clip to the frame's own bottom-right corner, not the shrunk box edge.
    expect(
      appearanceCrop({ x: 600, y: 300, width: 200, height: 200 }, { width: 640, height: 360 }),
    ).toEqual({
      left: 620,
      top: 320,
      width: 20,
      height: 40,
    })
  })
})

/**
 * A crude but honest sanity check (Task 9 review): the descriptor is not
 * validated against real footage here, only against the shape it must have —
 * stable under a small viewport shift, separated by a real colour change.
 * The distance helper is INLINE and not imported from `tracker-v2/appearance.ts`
 * (addons never import each other, CLAUDE.md); it need not match the real
 * `appearanceDistance` formula, only order the two cases correctly.
 */
function l2(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    sum += d * d
  }
  return Math.sqrt(sum)
}

describe('computeAppearanceDescriptor sanity (Task 9 review)', () => {
  it('is close for the same subject shifted a few pixels, and far for a differently coloured subject', () => {
    // A red blob on a dark background, in the vertical middle band — the
    // "subject". `dx` shifts the whole blob a couple of pixels, as a crop
    // drawn one pixel differently around the same real-world box would.
    const redSubject = (dx: number): RgbView =>
      view(16, 32, (x, y) => {
        const inBlob = x + dx >= 4 && x + dx < 12 && y >= 8 && y < 24
        return inBlob ? [220, 30, 30] : [20, 20, 20]
      })
    // Same shape and position, but blue: a genuinely different subject.
    const blueSubject: RgbView = view(16, 32, (x, y) => {
      const inBlob = x >= 4 && x < 12 && y >= 8 && y < 24
      return inBlob ? [30, 30, 220] : [20, 20, 20]
    })

    const base = computeAppearanceDescriptor(redSubject(0))
    const shifted = computeAppearanceDescriptor(redSubject(2))
    const differentColour = computeAppearanceDescriptor(blueSubject)

    const distanceUnderShift = l2(base.bins, shifted.bins)
    const distanceUnderColourChange = l2(base.bins, differentColour.bins)

    expect(distanceUnderShift).toBeLessThan(distanceUnderColourChange)
  })
})
