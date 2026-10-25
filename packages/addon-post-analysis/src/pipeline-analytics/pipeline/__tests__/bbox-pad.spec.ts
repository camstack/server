import { describe, it, expect } from 'vitest'
import { padBbox } from '../bbox-pad.js'

/**
 * Edge symmetry — the padded window must keep its REQUESTED extent on both
 * sides, shifting inward rather than truncating.
 *
 * The clamp was asymmetric: `x = max(0, rawX)` preserves the extent at the LEFT
 * edge (the window shifts right), but `w = min(rawW, 1 - x)` TRUNCATES it at the
 * right. Operator report, device 102 track `d6de2a61`, a car against the right
 * border (`envelope.maxX = 0.999`): the best shot came back with a blurred band
 * filling roughly the last 12% of the image, because the crop delivered less
 * width than was asked for.
 */
describe('padBbox edge symmetry', () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

  it('keeps the requested WIDTH against the right edge — the reported case', () => {
    // A subject hugging the right border, as measured on the live track.
    const padded = padBbox({ x: 0.9, y: 0.4, w: 0.099, h: 0.2 }, 0.25)
    const requestedW = 0.099 * 1.5
    expect(near(padded.w, requestedW)).toBe(true)
    // …by shifting inward, never past the frame.
    expect(padded.x + padded.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(padded.x).toBeGreaterThanOrEqual(0)
  })

  it('keeps the requested HEIGHT against the bottom edge', () => {
    const padded = padBbox({ x: 0.4, y: 0.9, w: 0.2, h: 0.099 }, 0.25)
    expect(near(padded.h, 0.099 * 1.5)).toBe(true)
    expect(padded.y + padded.h).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('still keeps the extent against the LEFT edge — the side that already worked', () => {
    const padded = padBbox({ x: 0.001, y: 0.4, w: 0.099, h: 0.2 }, 0.25)
    expect(near(padded.w, 0.099 * 1.5)).toBe(true)
    expect(padded.x).toBe(0)
  })

  it('shrinks ONLY when the padded window is bigger than the frame', () => {
    const padded = padBbox({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, 0.5)
    expect(padded.x).toBe(0)
    expect(padded.y).toBe(0)
    expect(padded.w).toBe(1)
    expect(padded.h).toBe(1)
  })

  it('is the identity at padding 0, wherever the box sits', () => {
    const box = { x: 0.9, y: 0.9, w: 0.099, h: 0.099 }
    expect(padBbox(box, 0)).toEqual(box)
  })
})
