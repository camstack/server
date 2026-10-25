import { describe, expect, it } from 'vitest'
import {
  countCroplessFaces,
  faceCropSrc,
  isCropless,
  selectCroplessFaceIds,
} from '../face-gallery-selection.js'

interface Row {
  faceId: string
  base64?: string
}

describe('face-gallery-selection', () => {
  const rows: readonly Row[] = [
    { faceId: 'a', base64: 'AAAA' },
    { faceId: 'b' }, // no crop
    { faceId: 'c', base64: '' }, // empty string counts as no crop
    { faceId: 'd', base64: 'BBBB' },
  ]

  it('isCropless is true only when base64 is missing or empty', () => {
    expect(isCropless({ faceId: 'a', base64: 'X' })).toBe(false)
    expect(isCropless({ faceId: 'b' })).toBe(true)
    expect(isCropless({ faceId: 'c', base64: '' })).toBe(true)
  })

  it('selectCroplessFaceIds returns only faces without a resolvable crop, in order', () => {
    expect(selectCroplessFaceIds(rows)).toEqual(['b', 'c'])
  })

  it('returns an empty array when every face has a crop', () => {
    expect(selectCroplessFaceIds([{ faceId: 'x', base64: 'Z' }])).toEqual([])
  })

  it('returns an empty array for an empty input', () => {
    expect(selectCroplessFaceIds([])).toEqual([])
  })

  it('countCroplessFaces counts the crop-less rows', () => {
    expect(countCroplessFaces(rows)).toBe(2)
    expect(countCroplessFaces([])).toBe(0)
  })

  it('isCropless is false when only cropUrl is present (includeCrops:false rows)', () => {
    expect(isCropless({ faceId: 'a', cropUrl: '/addon/pipeline-analytics/event-media/k' })).toBe(
      false,
    )
  })
})

describe('faceCropSrc', () => {
  const URL_A = '/addon/pipeline-analytics/event-media/face%3Aa%3Acrop%3A1'

  it('prefers the data-plane URL over the inline crop', () => {
    expect(faceCropSrc({ faceId: 'a', cropUrl: URL_A, base64: 'AAAA' })).toBe(URL_A)
  })

  it('returns the URL when there is no inline crop (includeCrops:false)', () => {
    expect(faceCropSrc({ faceId: 'a', cropUrl: URL_A })).toBe(URL_A)
  })

  it('falls back to a base64 data: URI when there is no URL', () => {
    expect(faceCropSrc({ faceId: 'a', base64: 'AAAA' })).toBe('data:image/jpeg;base64,AAAA')
  })

  it('treats an empty cropUrl as absent and falls back', () => {
    expect(faceCropSrc({ faceId: 'a', cropUrl: '', base64: 'AAAA' })).toBe(
      'data:image/jpeg;base64,AAAA',
    )
  })

  it('returns null when neither route resolves — the honest empty state', () => {
    expect(faceCropSrc({ faceId: 'a' })).toBeNull()
    expect(faceCropSrc({ faceId: 'a', cropUrl: '', base64: '' })).toBeNull()
  })

  it('returns null for an absent face so callers need no separate guard', () => {
    expect(faceCropSrc(undefined)).toBeNull()
    expect(faceCropSrc(null)).toBeNull()
  })

  it('agrees with isCropless — a null src is exactly a crop-less row', () => {
    for (const f of [
      { faceId: 'a', cropUrl: URL_A },
      { faceId: 'b', base64: 'X' },
      { faceId: 'c' },
      { faceId: 'd', cropUrl: '', base64: '' },
    ]) {
      expect(faceCropSrc(f) === null).toBe(isCropless(f))
    }
  })
})
