import { describe, expect, it } from 'vitest'
import { defined } from '../../../__tests__/support/vitest-mock.js'
import {
  CO_MOVING_MIN_CONTAINMENT,
  findCoMovingPairs,
  type CoMovingBox,
} from '../co-moving-subjects.js'

const box = (
  trackId: string,
  className: string,
  x: number,
  y: number,
  w: number,
  h: number,
): CoMovingBox => ({ trackId, className, bbox: { x, y, w, h } })

describe('findCoMovingPairs', () => {
  it('reports a rider contained in a bicycle box', () => {
    // The measured case: 9065ce35 (person, 11.3 s) lived entirely inside
    // cb8929d8 (vehicle, 32.3 s) and nothing recorded that they were together.
    const pairs = findCoMovingPairs(
      [box('person-1', 'person', 0.3, 0.3, 0.1, 0.2)],
      [box('bike-1', 'vehicle', 0.28, 0.28, 0.16, 0.26)],
    )
    expect(pairs).toHaveLength(1)
    const pair = defined(pairs[0], 'pairs[0]')
    expect(pair.otherTrackId).toBe('bike-1')
    expect(pair.containment).toBeGreaterThan(0.9)
  })

  it('reports a dog beside its handler', () => {
    // The opposite failure, same situation: here the two were folded into one
    // track and the `animal` label was refused.
    const pairs = findCoMovingPairs(
      [box('dog-1', 'animal', 0.5, 0.6, 0.08, 0.1)],
      [box('person-9', 'person', 0.48, 0.4, 0.12, 0.34)],
    )
    expect(pairs).toHaveLength(1)
    expect(defined(pairs[0], 'pairs[0]').className).toBe('animal')
  })

  it('says nothing about two subjects that merely pass each other', () => {
    const pairs = findCoMovingPairs(
      [box('a', 'person', 0.1, 0.1, 0.1, 0.2)],
      [box('b', 'vehicle', 0.18, 0.1, 0.1, 0.2)],
    )
    expect(pairs).toEqual([])
  })

  it('ignores same-class overlaps — that is the duplicate-track problem', () => {
    const pairs = findCoMovingPairs(
      [box('a', 'person', 0.1, 0.1, 0.1, 0.2)],
      [box('b', 'person', 0.1, 0.1, 0.1, 0.2)],
    )
    expect(pairs).toEqual([])
  })

  it('never divides by a zero-area box', () => {
    expect(
      findCoMovingPairs(
        [box('a', 'person', 0.1, 0.1, 0, 0)],
        [box('b', 'vehicle', 0.1, 0.1, 0.2, 0.2)],
      ),
    ).toEqual([])
    expect(
      findCoMovingPairs(
        [box('a', 'person', 0.1, 0.1, 0.2, 0.2)],
        [box('b', 'vehicle', 0.1, 0.1, 0, 0)],
      ),
    ).toEqual([])
  })

  it('does not report a track against itself', () => {
    const self = box('same', 'person', 0.1, 0.1, 0.2, 0.2)
    expect(findCoMovingPairs([self], [self])).toEqual([])
  })

  it('keeps the threshold a REPORTING one — loose enough to show near misses', () => {
    // Nothing branches on this value; it exists so the counts can be read.
    expect(CO_MOVING_MIN_CONTAINMENT).toBeLessThan(0.8)
  })
})
