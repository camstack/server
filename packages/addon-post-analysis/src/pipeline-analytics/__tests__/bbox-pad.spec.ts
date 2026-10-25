import { describe, it, expect } from 'vitest'
import { padBbox } from '../pipeline/bbox-pad.js'

describe('padBbox', () => {
  it('padding 0 is identity', () => {
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
    expect(padBbox(box, 0)).toEqual(box)
  })

  it('expands bbox correctly without clamping', () => {
    // box centered in the middle — padding 0.1 should expand by 10% of w/h on each side
    const box = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }
    const result = padBbox(box, 0.1)
    // newX = 0.3 - 0.1*0.4 = 0.3 - 0.04 = 0.26
    // newW = 0.4 + 2*0.1*0.4 = 0.4 + 0.08 = 0.48
    // newY = 0.3 - 0.1*0.4 = 0.26
    // newH = 0.4 + 2*0.1*0.4 = 0.48
    expect(result.x).toBeCloseTo(0.26)
    expect(result.y).toBeCloseTo(0.26)
    expect(result.w).toBeCloseTo(0.48)
    expect(result.h).toBeCloseTo(0.48)
  })

  it('clamps x to 0 when box is near the left edge', () => {
    const box = { x: 0.01, y: 0.3, w: 0.3, h: 0.3 }
    const result = padBbox(box, 0.5)
    expect(result.x).toBeGreaterThanOrEqual(0)
  })

  it('clamps y to 0 when box is near the top edge', () => {
    const box = { x: 0.3, y: 0.01, w: 0.3, h: 0.3 }
    const result = padBbox(box, 0.5)
    expect(result.y).toBeGreaterThanOrEqual(0)
  })

  it('clamps x+w to 1 when box is near the right edge', () => {
    const box = { x: 0.7, y: 0.3, w: 0.3, h: 0.3 }
    const result = padBbox(box, 0.5)
    expect(result.x + result.w).toBeLessThanOrEqual(1)
  })

  it('clamps y+h to 1 when box is near the bottom edge', () => {
    const box = { x: 0.3, y: 0.7, w: 0.3, h: 0.3 }
    const result = padBbox(box, 0.5)
    expect(result.y + result.h).toBeLessThanOrEqual(1)
  })

  it('large padding on a full-canvas box stays within [0,1]', () => {
    const box = { x: 0, y: 0, w: 1, h: 1 }
    const result = padBbox(box, 2)
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
    expect(result.x + result.w).toBeLessThanOrEqual(1)
    expect(result.y + result.h).toBeLessThanOrEqual(1)
  })

  it('returns a new object (immutable)', () => {
    const box = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }
    const result = padBbox(box, 0.1)
    expect(result).not.toBe(box)
  })
})
