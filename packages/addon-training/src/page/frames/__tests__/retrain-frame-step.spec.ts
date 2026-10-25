/**
 * ← / → across pages, and the open frame in the URL.
 */
import { describe, expect, it } from 'vitest'
import { applyFrameToSearchParams, readFrameParam } from '../frame-url.js'
import { edgeFrameId, lastPageOf, stepTarget } from '../lib/retrain-frame-step.js'

const ids = ['a', 'b', 'c']

describe('stepTarget', () => {
  it('walks within the page', () => {
    expect(stepTarget(ids, 'a', 1, 1, 3)).toEqual({ kind: 'frame', frameId: 'b' })
    expect(stepTarget(ids, 'c', -1, 1, 3)).toEqual({ kind: 'frame', frameId: 'b' })
  })
  it('crosses to the next page past the last frame, and the previous before the first', () => {
    expect(stepTarget(ids, 'c', 1, 1, 3)).toEqual({ kind: 'page', page: 2, edge: 'first' })
    expect(stepTarget(ids, 'a', -1, 2, 3)).toEqual({ kind: 'page', page: 1, edge: 'last' })
  })
  it('stops at either end of the corpus', () => {
    expect(stepTarget(ids, 'c', 1, 3, 3)).toEqual({ kind: 'none' })
    expect(stepTarget(ids, 'a', -1, 1, 3)).toEqual({ kind: 'none' })
  })
  it('does nothing for a frame not on the page', () => {
    expect(stepTarget(ids, 'zzz', 1, 1, 3)).toEqual({ kind: 'none' })
  })
  it('knows the page count and the edge frame', () => {
    expect(lastPageOf(0, 50)).toBe(1)
    expect(lastPageOf(101, 50)).toBe(3)
    expect(edgeFrameId(ids, 'first')).toBe('a')
    expect(edgeFrameId(ids, 'last')).toBe('c')
    expect(edgeFrameId([], 'first')).toBeUndefined()
  })
})

describe('?frame=', () => {
  it('reads the id the modal opens from', () => {
    expect(readFrameParam('?tab=frames&frame=f-12&page=2')).toBe('f-12')
    expect(readFrameParam('?tab=frames')).toBeNull()
    expect(readFrameParam('?frame=')).toBeNull()
  })
  it('writes and clears it without touching the corpus filter keys', () => {
    const params = new URLSearchParams('tab=frames&page=2&camera=3')
    applyFrameToSearchParams(params, 'f-9')
    expect(params.get('frame')).toBe('f-9')
    expect(params.get('page')).toBe('2')
    applyFrameToSearchParams(params, null)
    expect(params.has('frame')).toBe(false)
    expect(params.get('camera')).toBe('3')
  })
})
