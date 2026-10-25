import { describe, expect, it } from 'vitest'
import { plateCropSrc } from '../plate-crop-src.js'

describe('plateCropSrc', () => {
  it('prefers cropUrl — the bytes never ride the msgpack socket', () => {
    expect(
      plateCropSrc({ cropUrl: '/addon/pipeline-analytics/event-media/k', base64: 'AAAA' }),
    ).toBe('/addon/pipeline-analytics/event-media/k')
  })

  it('falls back to inline base64 for a row served before cropUrl existed', () => {
    expect(plateCropSrc({ base64: 'AAAA' })).toBe('data:image/jpeg;base64,AAAA')
  })

  it('returns null when the row has neither — the honest placeholder, never a broken image', () => {
    expect(plateCropSrc({})).toBeNull()
    expect(plateCropSrc({ cropUrl: '', base64: '' })).toBeNull()
  })

  it('accepts null/undefined so a caller holding an optional plate needs no guard', () => {
    expect(plateCropSrc(null)).toBeNull()
    expect(plateCropSrc(undefined)).toBeNull()
  })
})
