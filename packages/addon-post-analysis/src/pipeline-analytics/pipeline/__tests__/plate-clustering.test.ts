import { describe, it, expect } from 'vitest'
import {
  normalizePlate,
  canonicalizePlate,
  isPlausiblePlateRead,
  levenshtein,
  plateDistance,
  clusterByText,
  PLATE_MIN_SCORE,
} from '../plate-clustering.js'

describe('normalizePlate', () => {
  it('uppercases and strips separators, preserving confusable chars', () => {
    expect(normalizePlate('ab 123-cd')).toBe('AB123CD')
    expect(normalizePlate('ab0o1i')).toBe('AB0O1I')
  })
})

describe('isPlausiblePlateRead', () => {
  it('accepts a normal letters+digits read at good confidence', () => {
    expect(isPlausiblePlateRead('AB123CD', 0.9)).toBe(true)
    // Spaces (word gaps) and hyphens (display separators) are legitimate.
    expect(isPlausiblePlateRead('DW RO 309', 0.9)).toBe(true)
    expect(isPlausiblePlateRead('AB-123-CD', 0.9)).toBe(true)
  })

  it('rejects a read below the confidence floor', () => {
    expect(isPlausiblePlateRead('AB123CD', PLATE_MIN_SCORE - 0.01)).toBe(false)
  })

  it('rejects reads too short or missing the letter/digit mix', () => {
    expect(isPlausiblePlateRead('A1', 0.9)).toBe(false)
    expect(isPlausiblePlateRead('ABCDEF', 0.9)).toBe(false) // letters only
    expect(isPlausiblePlateRead('123456', 0.9)).toBe(false) // digits only
  })

  it('rejects raw reads carrying symbol glyphs (live-observed junk labels)', () => {
    // The OCR charset contains bracket/punctuation glyphs; the raw read must be
    // rejected BEFORE normalization strips (launders) the symbols.
    expect(isPlausiblePlateRead('[miv4o)', 0.9)).toBe(false)
    expect(isPlausiblePlateRead('6ou.2', 0.9)).toBe(false)
    expect(isPlausiblePlateRead('AB123CD!', 0.9)).toBe(false)
    expect(isPlausiblePlateRead('@em1', 0.9)).toBe(false)
  })
})

describe('canonicalizePlate', () => {
  it('folds common OCR confusions onto canonical symbols', () => {
    expect(canonicalizePlate('ABO')).toBe(canonicalizePlate('AB0'))
    expect(canonicalizePlate('1I L')).toBe('111')
    expect(canonicalizePlate('S5')).toBe('55')
  })
})

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('', '')).toBe(0)
    expect(levenshtein('abc', 'abc')).toBe(0)
    expect(levenshtein('abc', 'abd')).toBe(1)
    expect(levenshtein('abc', 'ab')).toBe(1)
    expect(levenshtein('kitten', 'sitting')).toBe(3)
  })
})

describe('plateDistance', () => {
  it('treats OCR-confused reads of the same plate as identical', () => {
    expect(plateDistance('AB123CD', 'A8123C0')).toBe(0) // B↔8, D↔0 folded
  })
  it('separates genuinely different plates', () => {
    expect(plateDistance('AB123CD', 'XY999ZZ')).toBeGreaterThan(2)
  })
})

describe('clusterByText', () => {
  it('groups near-identical reads and separates distinct plates', () => {
    const items = [
      { id: 'p1', text: 'AB123CD' },
      { id: 'p2', text: 'AB123CO' }, // O↔0 from CD... actually D vs O: folded both →0, distance 0
      { id: 'p3', text: 'A8123CD' }, // B↔8 → distance 0
      { id: 'p4', text: 'ZZ999XY' }, // different plate
    ]
    const clusters = clusterByText(items, 1)
    expect(clusters).toHaveLength(2)
    const big = clusters[0]!
    expect(big.size).toBe(3)
    expect(big.plateIds).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']))
    expect(big.representativePlateId).toBe('p1')
    expect(clusters[1]!.plateIds).toEqual(['p4'])
  })

  it('skips blank/garbage reads', () => {
    const clusters = clusterByText(
      [
        { id: 'a', text: '' },
        { id: 'b', text: '  -- ' },
      ],
      1,
    )
    expect(clusters).toHaveLength(0)
  })

  it('keeps one-edit-apart reads together but not two', () => {
    const items = [
      { id: 'a', text: 'AB123CD' },
      { id: 'b', text: 'AB124CD' }, // 1 substitution (3 vs 4, both digits, no fold)
      { id: 'c', text: 'AB777CD' }, // far
    ]
    const clusters = clusterByText(items, 1)
    expect(clusters[0]!.size).toBe(2)
    expect(clusters[0]!.plateIds).toEqual(expect.arrayContaining(['a', 'b']))
    expect(clusters.find((c) => c.plateIds.includes('c'))!.size).toBe(1)
  })

  it('sorts largest cluster first', () => {
    const items = [
      { id: 'x1', text: 'XY100ZZ' },
      { id: 'a1', text: 'AB200CD' },
      { id: 'a2', text: 'AB200CD' },
      { id: 'a3', text: 'AB200CD' },
    ]
    const clusters = clusterByText(items, 1)
    expect(clusters[0]!.size).toBe(3)
    expect(clusters[0]!.representativeText).toBe('AB200CD')
  })
})
