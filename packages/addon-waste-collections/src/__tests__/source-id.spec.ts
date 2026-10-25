import { describe, expect, it } from 'vitest'
import { allocateSourceId, slugifySourceLabel, SOURCE_ID_PATTERN } from '../source-id.js'

describe('slugifySourceLabel', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifySourceLabel('Home ZEW')).toBe('home-zew')
  })

  it('strips diacritics', () => {
    expect(slugifySourceLabel('Düren Nord')).toBe('duren-nord')
  })

  it('returns empty for punctuation-only', () => {
    expect(slugifySourceLabel('!!!')).toBe('')
  })
})

describe('allocateSourceId', () => {
  it('uses the slug when free', () => {
    expect(allocateSourceId('Home ZEW', [])).toBe('home-zew')
  })

  it('appends -2 on collision', () => {
    expect(allocateSourceId('Home ZEW', ['home-zew'])).toBe('home-zew-2')
  })

  it('falls back to source when label is empty of alphanumerics', () => {
    expect(allocateSourceId('***', [])).toBe('source')
  })

  it('always yields a pattern-valid id', () => {
    const id = allocateSourceId('A'.repeat(100), [])
    expect(SOURCE_ID_PATTERN.test(id)).toBe(true)
    expect(id.length).toBeLessThanOrEqual(64)
  })
})
