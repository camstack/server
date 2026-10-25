/**
 * Hover sync: the smallest box under the pointer, the emphasis a hover gives,
 * and the rule that a deleted box cannot stay hovered.
 */
import { describe, expect, it } from 'vitest'
import {
  emphasisOf,
  hoverAfterBoxesChange,
  hoverFromCanvas,
  sameHover,
} from '../lib/retrain-hover.js'

const boxes = [
  { key: 'big', bbox: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 } },
  { key: 'small', bbox: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 } },
]

describe('hoverFromCanvas', () => {
  it('picks the smallest box containing the point (a package held by a person)', () => {
    expect(hoverFromCanvas(boxes, { x: 0.35, y: 0.35 })).toEqual({ key: 'small', source: 'canvas' })
  })
  it('falls back to the containing big box, and to nothing on empty frame', () => {
    expect(hoverFromCanvas(boxes, { x: 0.2, y: 0.2 })?.key).toBe('big')
    expect(hoverFromCanvas(boxes, { x: 0.95, y: 0.95 })).toBeNull()
  })
})

describe('emphasisOf', () => {
  it('thickens the hovered box and dims every other', () => {
    const hover = { key: 'a', source: 'list' as const }
    expect(emphasisOf('a', hover)).toBe('hovered')
    expect(emphasisOf('b', hover)).toBe('dimmed')
  })
  it('dims nothing when nothing is hovered', () => {
    expect(emphasisOf('a', null)).toBe('normal')
  })
})

describe('hover state', () => {
  it('compares by key and source', () => {
    expect(sameHover(null, null)).toBe(true)
    expect(sameHover({ key: 'a', source: 'list' }, { key: 'a', source: 'canvas' })).toBe(false)
    expect(sameHover({ key: 'a', source: 'list' }, null)).toBe(false)
  })
  it('is dropped when its box disappears', () => {
    const hover = { key: 'a', source: 'canvas' as const }
    expect(hoverAfterBoxesChange(hover, ['a', 'b'])).toBe(hover)
    expect(hoverAfterBoxesChange(hover, ['b'])).toBeNull()
  })
})
