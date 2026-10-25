import { describe, it, expect } from 'vitest'
import { getByPath, setByPath } from '../path-util.js'

describe('getByPath', () => {
  it('reads a top-level and nested path', () => {
    expect(getByPath({ value: 142 }, 'value')).toBe(142)
    expect(getByPath({ a: { b: 'x' } }, 'a.b')).toBe('x')
  })
  it('returns undefined for a missing path without throwing', () => {
    expect(getByPath({ a: {} }, 'a.b.c')).toBeUndefined()
    expect(getByPath(null, 'a')).toBeUndefined()
  })
})

describe('setByPath', () => {
  it('sets a top-level key immutably (new object, original untouched)', () => {
    const orig = { state: 'paused', cleanWater: null }
    const next = setByPath(orig, 'state', 'docked')
    expect(next).toEqual({ state: 'docked', cleanWater: null })
    expect(orig.state).toBe('paused')
    expect(next).not.toBe(orig)
  })
  it('creates intermediate objects when the parent is null/missing', () => {
    const next = setByPath({ cleanWater: null }, 'cleanWater.status', 'low')
    expect(next).toEqual({ cleanWater: { status: 'low' } })
  })
  it('preserves untouched sibling keys on a nested set', () => {
    const next = setByPath({ cleanWater: { level: 50, status: null } }, 'cleanWater.status', 'full')
    expect(next).toEqual({ cleanWater: { level: 50, status: 'full' } })
  })
  it('clones every intermediate on a 3-level path and leaves untouched branches shared', () => {
    const orig = { a: { b: { c: 1 }, keep: 9 }, other: { x: 1 } }
    const next = setByPath(orig, 'a.b.c', 2)
    expect(next).toEqual({ a: { b: { c: 2 }, keep: 9 }, other: { x: 1 } })
    // rewritten path: every intermediate is a new reference
    expect(next.a).not.toBe(orig.a)
    expect(next.a.b).not.toBe(orig.a.b)
    // original untouched; an untouched branch may be structurally shared
    expect(orig.a.b.c).toBe(1)
    expect(next.other).toBe(orig.other)
  })
})
