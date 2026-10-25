import { describe, it, expect } from 'vitest'
import { fuzzyMatch, normalizeForSearch } from '../fuzzy-match'

describe('normalizeForSearch', () => {
  it('lowercases the string', () => {
    expect(normalizeForSearch('Tapparella')).toBe('tapparella')
  })

  it('strips hyphens', () => {
    expect(normalizeForSearch('tapparella-kitchen')).toBe('tapparellakitchen')
  })

  it('strips underscores', () => {
    expect(normalizeForSearch('tapparella_kitchen')).toBe('tapparellakitchen')
  })

  it('strips whitespace', () => {
    expect(normalizeForSearch('Tapparella kitchen')).toBe('tapparellakitchen')
  })

  it('strips mixed separators', () => {
    expect(normalizeForSearch('tapparella - kitchen_living_room')).toBe(
      'tapparellakitchenlivingroom',
    )
  })

  it('returns empty string for empty input', () => {
    expect(normalizeForSearch('')).toBe('')
  })

  it('makes Tapparella kitchen equal to tapparella-kitchen after normalization', () => {
    expect(normalizeForSearch('Tapparella kitchen')).toBe(normalizeForSearch('tapparella-kitchen'))
  })
})

describe('fuzzyMatch', () => {
  it('matches when query and target are identical', () => {
    expect(fuzzyMatch('camera', 'camera')).toBe(true)
  })

  it('is case insensitive', () => {
    expect(fuzzyMatch('Camera', 'camera')).toBe(true)
    expect(fuzzyMatch('camera', 'CAMERA')).toBe(true)
  })

  it('treats hyphens and spaces as equivalent: Tapparella kitchen → tapparella-kitchen', () => {
    expect(fuzzyMatch('Tapparella kitchen', 'tapparella-kitchen')).toBe(true)
  })

  it('treats hyphens and spaces as equivalent (reversed): tapparella kitchen → Tapparella-Kitchen', () => {
    expect(fuzzyMatch('tapparella kitchen', 'Tapparella-Kitchen')).toBe(true)
  })

  it('treats underscores and spaces as equivalent', () => {
    expect(fuzzyMatch('tapparella kitchen', 'tapparella_kitchen')).toBe(true)
  })

  it('does not match unrelated queries', () => {
    expect(fuzzyMatch('xyz', 'tapparella-kitchen')).toBe(false)
  })

  it('matches stableId-style strings', () => {
    expect(fuzzyMatch('front door', 'front-door-camera')).toBe(true)
  })

  it('returns true for an empty query (matches everything)', () => {
    expect(fuzzyMatch('', 'tapparella-kitchen')).toBe(true)
    expect(fuzzyMatch('', '')).toBe(true)
  })

  it('does partial (substring) matching', () => {
    expect(fuzzyMatch('tap', 'tapparella-kitchen')).toBe(true)
    expect(fuzzyMatch('kitchen', 'tapparella-kitchen')).toBe(true)
  })

  it('does not match when query is longer than target', () => {
    expect(fuzzyMatch('tapparella kitchen living room extra', 'tapparella-kitchen')).toBe(false)
  })
})
