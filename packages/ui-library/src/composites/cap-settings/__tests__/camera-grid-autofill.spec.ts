/**
 * The two geometries the editor gained: filling the canvas, and dragging a
 * rectangle by any of its eight handles.
 *
 * Both are pure and both are testable without a DOM, which is the point of
 * keeping them out of the component: a rectangle that leaves the unit square
 * makes the ADDON throw (a silently clipped picture is worse than a refusal),
 * so every path here has to end in a clamp.
 */
import { describe, expect, it } from 'vitest'
import {
  autofillCellRects,
  resizeNormalizedRectFrom,
  type GridNormalizedRect,
} from '../camera-grid-layout.js'

const UNIT: GridNormalizedRect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }

function coverage(rects: readonly GridNormalizedRect[]): number {
  return rects.reduce((sum, r) => sum + r.width * r.height, 0)
}

describe('autofillCellRects', () => {
  it('leaves NOTHING uncovered — the areas sum to the whole canvas', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 16]) {
      expect(coverage(autofillCellRects(count))).toBeCloseTo(1, 6)
      expect(autofillCellRects(count)).toHaveLength(count)
    }
  })

  it('gives one camera the whole canvas', () => {
    expect(autofillCellRects(1)).toEqual([{ x: 0, y: 0, width: 1, height: 1 }])
  })

  it('splits two side by side, four into quarters', () => {
    expect(autofillCellRects(2)).toEqual([
      { x: 0, y: 0, width: 0.5, height: 1 },
      { x: 0.5, y: 0, width: 0.5, height: 1 },
    ])
    expect(autofillCellRects(4)).toEqual([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ])
  })

  it('stretches a short last row rather than leaving a hole', () => {
    // Three cells: two on top, one below spanning the full width. The
    // alternative — a 2x2 with an empty quarter — is the layout an operator
    // asks autofill to avoid.
    expect(autofillCellRects(3)).toEqual([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 1, height: 0.5 },
    ])
  })

  it('answers an empty canvas for no cells rather than dividing by zero', () => {
    expect(autofillCellRects(0)).toEqual([])
  })
})

describe('resizeNormalizedRectFrom', () => {
  it('anchors the opposite corner — dragging NW moves the origin and shrinks', () => {
    expect(resizeNormalizedRectFrom(UNIT, 'nw', 0.1, 0.1)).toEqual({
      x: 0.35,
      y: 0.35,
      width: 0.4,
      height: 0.4,
    })
  })

  it('dragging SE keeps the origin, matching the handle that already existed', () => {
    expect(resizeNormalizedRectFrom(UNIT, 'se', 0.25, 0.25)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.75,
      height: 0.75,
    })
  })

  it('an EDGE handle moves one dimension only', () => {
    expect(resizeNormalizedRectFrom(UNIT, 'e', 0.2, 0.4)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.7,
      height: 0.5,
    })
    expect(resizeNormalizedRectFrom(UNIT, 'n', 0.4, 0.1)).toEqual({
      x: 0.25,
      y: 0.35,
      width: 0.5,
      height: 0.4,
    })
  })

  it('never leaves the unit square, whichever handle is dragged off it', () => {
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      for (const [dx, dy] of [
        [-5, -5],
        [5, 5],
        [5, -5],
        [-5, 5],
      ] as const) {
        const out = resizeNormalizedRectFrom(UNIT, handle, dx, dy)
        expect(out.x).toBeGreaterThanOrEqual(0)
        expect(out.y).toBeGreaterThanOrEqual(0)
        expect(out.x + out.width).toBeLessThanOrEqual(1 + 1e-9)
        expect(out.y + out.height).toBeLessThanOrEqual(1 + 1e-9)
        expect(out.width).toBeGreaterThan(0)
        expect(out.height).toBeGreaterThan(0)
      }
    }
  })
})
