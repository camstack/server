import { describe, it, expect } from 'vitest'
import { votePlateText, type PlateReadVote } from '../plate-vote.js'

function reads(...pairs: readonly (readonly [string, number])[]): PlateReadVote[] {
  return pairs.map(([text, score]) => ({ text, score }))
}

describe('votePlateText', () => {
  /**
   * The live failure this replaces: `holdBest` kept the argmax over OCR score,
   * and score does NOT correlate with correctness. Here the WORST-scoring pair
   * of reads agree on the two glyphs the best-scoring read got wrong.
   */
  it('outvotes the highest-scoring read character by character', () => {
    expect(votePlateText(reads(['DNRO3O9', 0.9], ['DNRO309', 0.6], ['DNR0309', 0.55]))).toBe(
      'DNRO309',
    )
  })

  it('returns the single read unchanged when there is nothing to vote on', () => {
    expect(votePlateText(reads(['DNRO309', 0.9]))).toBe('DNRO309')
  })

  it('normalizes before voting (case + separators never split a vote)', () => {
    expect(votePlateText(reads(['dn ro 309', 0.5], ['DNRO309', 0.5], ['DNRO3O9', 0.4]))).toBe(
      'DNRO309',
    )
  })

  it('aligns reads of different length instead of voting on a shifted index', () => {
    // "NRO309" lost its leading D; a naive positional vote would then have N
    // voting against D at position 0 and shift every later glyph. Aligned, the
    // shorter read agrees with the majority everywhere it has a character.
    expect(votePlateText(reads(['DNRO3O9', 0.9], ['NRO309', 0.6], ['DNRO309', 0.55]))).toBe(
      'DNRO309',
    )
  })

  it('lets a confident majority overturn a longer hallucinated read', () => {
    // An 9-glyph read with two spurious characters must not set the length.
    expect(votePlateText(reads(['DNRO309XX', 0.8], ['DNRO309', 0.7], ['DNRO3O9', 0.6]))).toBe(
      'DNRO309',
    )
  })

  it('returns the empty string for no reads', () => {
    expect(votePlateText([])).toBe('')
  })
})
