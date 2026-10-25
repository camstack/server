import { describe, it, expect } from 'vitest'
import { locationSimilarity, bestLocationMatch } from '../util/location-match'

describe('locationSimilarity', () => {
  it('is 1 for identical (case/whitespace-insensitive)', () => {
    expect(locationSimilarity('Kitchen', 'kitchen')).toBe(1)
    expect(locationSimilarity('  Living Room ', 'living room')).toBe(1)
  })
  it('is between 0 and 1 for near matches and lower for distant', () => {
    expect(locationSimilarity('Kitchen', 'Kitchenette')).toBeGreaterThan(0.5)
    expect(locationSimilarity('Kitchen', 'Garage')).toBeLessThan(0.5)
  })
  it('is 0 when one side is empty', () => {
    expect(locationSimilarity('Kitchen', '')).toBe(0)
  })
})

describe('bestLocationMatch', () => {
  it('reuses an existing name on a case-insensitive exact match', () => {
    expect(bestLocationMatch('Kitchen', ['kitchen', 'Garage'])).toBe('kitchen')
  })
  it('reuses the closest existing name above the threshold', () => {
    expect(bestLocationMatch('Living Rom', ['Living Room', 'Garage'])).toBe('Living Room')
  })
  it('returns null when nothing is close enough (→ caller creates a new one)', () => {
    expect(bestLocationMatch('Basement', ['Kitchen', 'Garage'])).toBeNull()
  })
  it('returns null for an empty existing list', () => {
    expect(bestLocationMatch('Kitchen', [])).toBeNull()
  })
  it('picks the highest-similarity candidate among several', () => {
    expect(bestLocationMatch('Bedroom', ['Bed', 'Bedroom 2', 'Bedroom'])).toBe('Bedroom')
  })
})
