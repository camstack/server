import { describe, expect, it } from 'vitest'
import { areaRatio, centreDistance, diagonal, iou } from '../geometry.js'

describe('tracker-v2 geometry', () => {
  it('iou of identical, disjoint and half-overlapping boxes', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    expect(iou(a, a)).toBe(1)
    expect(iou(a, { x: 20, y: 0, w: 10, h: 10 })).toBe(0)
    expect(iou(a, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(50 / 150, 10)
  })

  it('areaRatio is symmetric, ≥ 1, and infinite for an empty box', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    const b = { x: 0, y: 0, w: 20, h: 20 }
    expect(areaRatio(a, b)).toBe(4)
    expect(areaRatio(b, a)).toBe(4)
    expect(areaRatio(a, { x: 0, y: 0, w: 0, h: 5 })).toBe(Number.POSITIVE_INFINITY)
  })

  it('the 102 car of 28/09 is ×9.5 the corpse it inherited', () => {
    // D678: corpse [2748,582 409×628], arriving car [2070,2 235×115].
    expect(
      areaRatio({ x: 2748, y: 582, w: 409, h: 628 }, { x: 2070, y: 2, w: 235, h: 115 }),
    ).toBeCloseTo(9.5, 1)
  })

  it('centre distance and diagonal', () => {
    expect(centreDistance({ x: 0, y: 0, w: 2, h: 2 }, { x: 3, y: 4, w: 2, h: 2 })).toBe(5)
    expect(diagonal({ x: 0, y: 0, w: 3, h: 4 })).toBe(5)
  })
})
