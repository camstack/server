import { describe, expect, it } from 'vitest'
import { normalizeSearchText } from '../search-normalize'

describe('normalizeSearchText', () => {
  it('lowercases', () => {
    expect(normalizeSearchText('HALL')).toBe('hall')
    expect(normalizeSearchText('Hall')).toBe('hall')
  })

  it('strips diacritics so accented and plain text match', () => {
    expect(normalizeSearchText('Perché')).toBe('perche')
    expect(normalizeSearchText('perche')).toBe('perche')
    expect(normalizeSearchText('Perché')).toBe(normalizeSearchText('perche'))
  })

  it('handles multiple accented characters and mixed case together', () => {
    expect(normalizeSearchText('Front door è più caldo')).toBe('front door e piu caldo')
  })

  it('trims leading/trailing whitespace', () => {
    expect(normalizeSearchText('  hall  ')).toBe('hall')
  })

  it('is a no-op on already-normalized ascii text', () => {
    expect(normalizeSearchText('camera')).toBe('camera')
  })

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(normalizeSearchText('')).toBe('')
    expect(normalizeSearchText('   ')).toBe('')
  })
})
