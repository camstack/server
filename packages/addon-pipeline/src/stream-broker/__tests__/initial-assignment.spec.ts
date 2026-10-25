import { describe, expect, it } from 'vitest'
import { rankInitialAssignment, type RankableStream } from '../initial-assignment.js'

const stream = (
  camStreamId: string,
  order: number,
  extra: Partial<RankableStream> = {},
): RankableStream => ({ camStreamId, order, autoEligible: true, ...extra })

/**
 * The broker's automatic profile ranking, extracted so a publisher's
 * `profileHint` can be pinned without a manager around it. The pixel-count
 * heuristic is unchanged for every camera that does not hint — those cases
 * are the first block, byte-for-byte what `computeInitialAssignment` did.
 */
describe('rankInitialAssignment — the heuristic, unchanged when nobody hints', () => {
  it('one stream lands on mid, two on high+low, three on all three, by pixels then order', () => {
    expect(rankInitialAssignment([stream('a', 0)])).toEqual({ mid: 'a' })
    expect(
      rankInitialAssignment([
        stream('sub', 0, { resolution: { width: 640, height: 360 } }),
        stream('main', 1, { resolution: { width: 1920, height: 1080 } }),
      ]),
    ).toEqual({ high: 'main', low: 'sub' })
    expect(rankInitialAssignment([stream('a', 0), stream('b', 1), stream('c', 2)])).toEqual({
      high: 'a',
      mid: 'b',
      low: 'c',
    })
  })

  it('ineligible streams are never ranked; all-ineligible yields an empty map', () => {
    expect(rankInitialAssignment([stream('x', 0, { autoEligible: false })])).toEqual({})
    expect(
      rankInitialAssignment([stream('x', 0, { autoEligible: false }), stream('y', 1)]),
    ).toEqual({ mid: 'y' })
  })
})

describe('rankInitialAssignment — a publisher that names the slot its stream IS', () => {
  it('a single hinted stream goes to the hinted slot, not to mid', () => {
    expect(rankInitialAssignment([stream('live', 0, { profileHint: 'low' })])).toEqual({
      low: 'live',
    })
  })

  it('hinted streams take their slots first; the rest are ranked into what is left', () => {
    expect(
      rankInitialAssignment([
        stream('sub', 0, { profileHint: 'low', resolution: { width: 1920, height: 1080 } }),
        stream('main', 1, { resolution: { width: 640, height: 360 } }),
      ]),
    ).toEqual({ low: 'sub', high: 'main' })
  })

  it('two streams hinting the same slot: the first published keeps it, the other is ranked', () => {
    expect(
      rankInitialAssignment([
        stream('a', 0, { profileHint: 'low' }),
        stream('b', 1, { profileHint: 'low' }),
      ]),
    ).toEqual({ low: 'a', high: 'b' })
  })

  it('an ineligible stream is not placed by its hint either', () => {
    expect(
      rankInitialAssignment([stream('a', 0, { profileHint: 'low', autoEligible: false })]),
    ).toEqual({})
  })
})
