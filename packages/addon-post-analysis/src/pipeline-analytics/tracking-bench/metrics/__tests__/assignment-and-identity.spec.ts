/**
 * The two primitives every standard metric stands on, ported from TrackEval
 * (MIT): the rectangular min-cost assignment scipy provides, and the Identity
 * metric (IDF1). Values here are computed by hand — they are the cross-check;
 * no reference implementation is run (D681 keeps metrics local).
 *
 * Disarm: replace the Hungarian loop with a greedy row-wise minimum — the
 * "greedy loses" test must fail.
 */
import { describe, expect, it } from 'vitest'
import { linearSumAssignment } from '../assignment.js'
import { computeIdentity } from '../idf1.js'
import type { MetricSequence } from '../metric-sequence.js'

function cost(
  rows: readonly (readonly number[])[],
  a: { rows: readonly number[]; cols: readonly number[] },
): number {
  return a.rows.reduce((sum, r, k) => sum + (rows[r]?.[a.cols[k] ?? 0] ?? 0), 0)
}

describe('linearSumAssignment', () => {
  it('solves the scipy documentation example', () => {
    const m = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ]
    const a = linearSumAssignment(m)
    expect(a).toEqual({ rows: [0, 1, 2], cols: [1, 0, 2] })
    expect(cost(m, a)).toBe(5)
  })

  it('beats greedy where greedy loses', () => {
    const m = [
      [1, 2],
      [1, 100],
    ]
    expect(cost(m, linearSumAssignment(m))).toBe(3)
  })

  it('handles more rows than columns, leaving the worst row out', () => {
    expect(
      linearSumAssignment([
        [5, 1],
        [1, 5],
        [3, 3],
      ]),
    ).toEqual({ rows: [0, 1], cols: [1, 0] })
  })

  it('handles an empty side', () => {
    expect(linearSumAssignment([])).toEqual({ rows: [], cols: [] })
    expect(linearSumAssignment([[], []])).toEqual({ rows: [], cols: [] })
  })
})

const ID = [
  [1, 0],
  [0, 1],
]
const SWAPPED = [
  [0, 1],
  [1, 0],
]

describe('computeIdentity', () => {
  it('is 1 for a perfect pair', () => {
    const seq: MetricSequence = {
      numGtIds: 2,
      numTrIds: 2,
      frames: [0, 1, 2].map(() => ({ gtIds: [0, 1], trIds: [0, 1], similarity: ID })),
    }
    expect(computeIdentity(seq)).toMatchObject({ IDTP: 6, IDFN: 0, IDFP: 0, IDF1: 1 })
  })

  it('halves on a swap midway', () => {
    const seq: MetricSequence = {
      numGtIds: 2,
      numTrIds: 2,
      frames: [ID, ID, SWAPPED, SWAPPED].map((similarity) => ({
        gtIds: [0, 1],
        trIds: [0, 1],
        similarity,
      })),
    }
    expect(computeIdentity(seq)).toMatchObject({ IDTP: 4, IDFN: 4, IDFP: 4, IDF1: 0.5 })
  })

  it('is 0 with no tracker detections, IDFN = every gt detection', () => {
    const seq: MetricSequence = {
      numGtIds: 1,
      numTrIds: 0,
      frames: [{ gtIds: [0], trIds: [], similarity: [[]] }],
    }
    expect(computeIdentity(seq)).toMatchObject({ IDTP: 0, IDFN: 1, IDFP: 0, IDF1: 0 })
  })
})
