/**
 * The assignment L1 and L2 both solve. Hungarian, not greedy: the greedy
 * "highest overlap first" pass is what let a velocity-overshot prediction take
 * the neighbour's box on 101 (28/09 05:59:11Z).
 *
 * Disarm: make `minCostAssignment` return, for each row, its cheapest column
 * (greedy) — "prefers the global optimum" must fail.
 */
import { describe, expect, it } from 'vitest'
import { FORBIDDEN, minCostAssignment } from '../assignment.js'

describe('minCostAssignment', () => {
  it('returns nothing for an empty matrix', () => {
    expect(minCostAssignment([])).toEqual([])
    expect(minCostAssignment([[]])).toEqual([])
  })

  it('prefers the global optimum over each row greedily', () => {
    // Greedy: row 0 takes col 0 (0.1), row 1 is left with col 1 (0.9) → 1.0.
    // Optimum: row 0 → col 1 (0.2), row 1 → col 0 (0.2) → 0.4.
    const pairs = minCostAssignment([
      [0.1, 0.2],
      [0.2, 0.9],
    ])
    expect(pairs).toEqual([
      { row: 0, col: 1, cost: 0.2 },
      { row: 1, col: 0, cost: 0.2 },
    ])
  })

  it('never returns a forbidden pair, leaving the row unassigned instead', () => {
    const pairs = minCostAssignment([
      [FORBIDDEN, FORBIDDEN],
      [0.3, FORBIDDEN],
    ])
    expect(pairs).toEqual([{ row: 1, col: 0, cost: 0.3 }])
  })

  it('handles rectangular matrices both ways', () => {
    expect(minCostAssignment([[0.5, 0.1, 0.9]])).toEqual([{ row: 0, col: 1, cost: 0.1 }])
    expect(minCostAssignment([[0.5], [0.1], [0.9]])).toEqual([{ row: 1, col: 0, cost: 0.1 }])
  })

  it('is deterministic on ties', () => {
    const m = [
      [0.5, 0.5],
      [0.5, 0.5],
    ]
    expect(minCostAssignment(m)).toEqual(minCostAssignment(m))
  })
})
