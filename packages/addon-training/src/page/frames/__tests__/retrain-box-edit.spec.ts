/**
 * Moving and resizing a box — the geometry a correction is made of. Every
 * result stays inside the frame and never shrinks below the minimum box.
 */
import { describe, expect, it } from 'vitest'
import { handleAtPoint, MIN_BOX_SIDE, moveBox, resizeBox } from '../lib/retrain-boxes.js'

const box = { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }

function close(actual: { x: number; y: number; w: number; h: number }, expected: typeof actual) {
  expect(actual.x).toBeCloseTo(expected.x)
  expect(actual.y).toBeCloseTo(expected.y)
  expect(actual.w).toBeCloseTo(expected.w)
  expect(actual.h).toBeCloseTo(expected.h)
}

describe('moveBox', () => {
  it('translates by the delta', () => {
    close(moveBox(box, 0.1, -0.05), { x: 0.3, y: 0.15, w: 0.2, h: 0.2 })
  })

  it('stops at the frame edge without changing the size', () => {
    close(moveBox(box, 2, -2), { x: 0.8, y: 0, w: 0.2, h: 0.2 })
  })
})

describe('resizeBox', () => {
  it('a corner handle moves that corner, the opposite one stays', () => {
    close(resizeBox(box, 'se', { x: 0.5, y: 0.6 }), { x: 0.2, y: 0.2, w: 0.3, h: 0.4 })
    close(resizeBox(box, 'nw', { x: 0.1, y: 0.15 }), { x: 0.1, y: 0.15, w: 0.3, h: 0.25 })
  })

  it('an edge handle moves one edge only', () => {
    close(resizeBox(box, 'e', { x: 0.7, y: 0.9 }), { x: 0.2, y: 0.2, w: 0.5, h: 0.2 })
    close(resizeBox(box, 'n', { x: 0.9, y: 0.1 }), { x: 0.2, y: 0.1, w: 0.2, h: 0.3 })
  })

  it('never collapses below the minimum, and never inverts', () => {
    const squashed = resizeBox(box, 'e', { x: 0.1, y: 0.3 })
    expect(squashed.w).toBeCloseTo(MIN_BOX_SIDE)
    expect(squashed.x).toBeCloseTo(0.2)
  })

  it('clamps into the frame', () => {
    close(resizeBox(box, 'se', { x: 1.4, y: -0.5 }), {
      x: 0.2,
      y: 0.2,
      w: 0.8,
      h: MIN_BOX_SIDE,
    })
  })
})

describe('handleAtPoint', () => {
  const tol = { x: 0.02, y: 0.02 }
  it('finds the corner, then the edge, then the body', () => {
    expect(handleAtPoint(box, { x: 0.4, y: 0.4 }, tol)).toBe('se')
    expect(handleAtPoint(box, { x: 0.205, y: 0.3 }, tol)).toBe('w')
    expect(handleAtPoint(box, { x: 0.3, y: 0.3 }, tol)).toBe('body')
    expect(handleAtPoint(box, { x: 0.7, y: 0.7 }, tol)).toBeNull()
  })
})
