import { describe, it, expect } from 'vitest'
import { normalizeFaceBbox } from '../face-bbox.js'

describe('normalizeFaceBbox', () => {
  it('normalizes a pixel bbox against the frame dimensions', () => {
    const box = normalizeFaceBbox({ x: 100, y: 50, w: 200, h: 100 }, 1000, 500)
    expect(box).not.toBeNull()
    expect(box!.x).toBeCloseTo(0.1)
    expect(box!.y).toBeCloseTo(0.1)
    expect(box!.width).toBeCloseTo(0.2)
    expect(box!.height).toBeCloseTo(0.2)
  })

  it('clamps a bbox that overhangs the frame on the right/bottom', () => {
    const box = normalizeFaceBbox({ x: 900, y: 450, w: 300, h: 300 }, 1000, 500)
    expect(box).not.toBeNull()
    expect(box!.x).toBeCloseTo(0.9)
    expect(box!.y).toBeCloseTo(0.9)
    // width/height clamped so x+width <= 1 and y+height <= 1
    expect(box!.x + box!.width).toBeLessThanOrEqual(1)
    expect(box!.y + box!.height).toBeLessThanOrEqual(1)
  })

  it('clamps a bbox with a negative origin', () => {
    const box = normalizeFaceBbox({ x: -50, y: -20, w: 200, h: 100 }, 1000, 500)
    expect(box).not.toBeNull()
    expect(box!.x).toBe(0)
    expect(box!.y).toBe(0)
  })

  it('returns null when frame width is zero', () => {
    expect(normalizeFaceBbox({ x: 0, y: 0, w: 10, h: 10 }, 0, 500)).toBeNull()
  })

  it('returns null when frame height is negative', () => {
    expect(normalizeFaceBbox({ x: 0, y: 0, w: 10, h: 10 }, 500, -10)).toBeNull()
  })

  it('returns null when frame dims are NaN', () => {
    expect(normalizeFaceBbox({ x: 0, y: 0, w: 10, h: 10 }, Number.NaN, 500)).toBeNull()
  })

  it('returns a degenerate but valid box when the bbox itself is zero-sized', () => {
    const box = normalizeFaceBbox({ x: 10, y: 10, w: 0, h: 0 }, 100, 100)
    expect(box).toEqual({ x: 0.1, y: 0.1, width: 0, height: 0 })
  })
})
