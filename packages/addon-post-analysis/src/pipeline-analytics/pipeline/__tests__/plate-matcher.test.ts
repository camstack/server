import { describe, it, expect } from 'vitest'
import {
  matchPlateText,
  DEFAULT_PLATE_MATCH_OPTS,
  type PlateGallerySample,
} from '../plate-matcher.js'

const GALLERY: readonly PlateGallerySample[] = [
  { vehicleId: 'van', text: 'AB123CD' },
  { vehicleId: 'car', text: 'XY999ZZ' },
]

describe('matchPlateText', () => {
  it('exact folded match names the vehicle at any score', () => {
    const m = matchPlateText({ text: 'AB123CD', score: 0.2 }, GALLERY, DEFAULT_PLATE_MATCH_OPTS)
    expect(m).toEqual({ vehicleId: 'van', distance: 0 })
  })

  it('a high-confidence read matches within maxDistance=1 (one OCR slip)', () => {
    // AB123CO vs AB123CD → folded O→0, D→0 so they coincide → distance 0 actually;
    // use a genuinely 1-off folded pair: AB123CX vs AB123CD (X not folded) → dist 1.
    const m = matchPlateText({ text: 'AB123CX', score: 0.9 }, GALLERY, DEFAULT_PLATE_MATCH_OPTS)
    expect(m).toEqual({ vehicleId: 'van', distance: 1 })
  })

  it('a low-confidence read is held to exact-only (distance 0), so a 1-off does NOT match', () => {
    const m = matchPlateText({ text: 'AB123CX', score: 0.3 }, GALLERY, DEFAULT_PLATE_MATCH_OPTS)
    expect(m).toBeNull()
  })

  it('a low-confidence read still matches on an exact fold (distance 0)', () => {
    // O folds to 0, D folds to 0 → AB123CO === AB123CD after canonicalization.
    const m = matchPlateText({ text: 'AB123CO', score: 0.1 }, GALLERY, DEFAULT_PLATE_MATCH_OPTS)
    expect(m).toEqual({ vehicleId: 'van', distance: 0 })
  })

  it('returns null when nothing is within the allowed distance', () => {
    const m = matchPlateText({ text: 'QQ000QQ', score: 0.9 }, GALLERY, DEFAULT_PLATE_MATCH_OPTS)
    expect(m).toBeNull()
  })

  it('a tie between two vehicles at the same distance → no match', () => {
    const tied: readonly PlateGallerySample[] = [
      { vehicleId: 'a', text: 'AB123CD' },
      { vehicleId: 'b', text: 'AB123CE' },
    ]
    // probe 1 edit from both 'a' and 'b' (folded) → ambiguous.
    const m = matchPlateText({ text: 'AB123CF', score: 0.9 }, tied, DEFAULT_PLATE_MATCH_OPTS)
    expect(m).toBeNull()
  })

  it('picks the strictly-closer vehicle when distances differ', () => {
    const g: readonly PlateGallerySample[] = [
      { vehicleId: 'near', text: 'AB123CD' },
      { vehicleId: 'far', text: 'ZZ999ZZ' },
    ]
    const m = matchPlateText({ text: 'AB123CX', score: 0.9 }, g, DEFAULT_PLATE_MATCH_OPTS)
    expect(m?.vehicleId).toBe('near')
  })

  it('empty gallery → null', () => {
    expect(matchPlateText({ text: 'AB123CD', score: 0.9 }, [], DEFAULT_PLATE_MATCH_OPTS)).toBeNull()
  })
})
