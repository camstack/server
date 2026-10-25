/**
 * The comparator every v2 appearance decision uses (§8.2).
 *
 * Disarms (each alone, restored):
 *  - in `appearanceDistance`, ignore `gray` and always compare all six
 *    blocks: "a gray side compares only value and gradient" fails;
 *  - in `foldAppearance`, fold every read into `colour`: "gray and colour
 *    reads are kept apart" fails.
 */
import { APPEARANCE_BIN_COUNT, type AppearanceDescriptor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  aggregateDistance,
  appearanceDistance,
  distanceToAggregate,
  foldAppearance,
} from '../appearance.js'

function desc(fill: (i: number) => number, gray = false): AppearanceDescriptor {
  return { version: 1, bins: Array.from({ length: APPEARANCE_BIN_COUNT }, (_, i) => fill(i)), gray }
}
const hs = (i: number): boolean => i < 32 || (i >= 48 && i < 80)

describe('appearanceDistance', () => {
  it('is 0 for identical descriptors', () => {
    const d = desc((i) => (i % 7) + 1)
    expect(appearanceDistance(d, d)).toBeCloseTo(0, 10)
  })

  it('is 1 for descriptors with no bin in common', () => {
    expect(
      appearanceDistance(
        desc((i) => (i % 2 === 0 ? 10 : 0)),
        desc((i) => (i % 2 === 1 ? 10 : 0)),
      ),
    ).toBeCloseTo(1, 10)
  })

  it('a gray side compares only value and gradient', () => {
    const a = desc((i) => (hs(i) ? (i % 2 === 0 ? 5 : 0) : 3), true)
    const b = desc((i) => (hs(i) ? (i % 2 === 1 ? 5 : 0) : 3))
    expect(appearanceDistance(a, b)).toBeCloseTo(0, 10)
  })

  it('is undefined when the vectors cannot be compared', () => {
    const a = desc(() => 1)
    expect(appearanceDistance(a, { bins: [1, 2, 3], gray: false })).toBeUndefined()
    expect(
      appearanceDistance(
        desc(() => 0),
        a,
      ),
    ).toBeUndefined()
  })
})

describe('aggregates', () => {
  it('gray and colour reads are kept apart', () => {
    const colourRed = desc((i) => (hs(i) ? (i % 2 === 0 ? 9 : 0) : 3))
    const grayNoise = desc((i) => (hs(i) ? (i % 2 === 1 ? 9 : 0) : 3), true)
    const agg = foldAppearance(foldAppearance(null, colourRed), grayNoise)
    expect(agg.colour?.count).toBe(1)
    expect(agg.gray?.count).toBe(1)
    // A colour probe is compared with the colour mean, untouched by the IR read.
    expect(distanceToAggregate(agg, colourRed)).toBeCloseTo(0, 10)
  })

  it('a running mean per mode', () => {
    const agg = foldAppearance(
      foldAppearance(
        null,
        desc(() => 2),
      ),
      desc(() => 4),
    )
    expect(agg.colour?.bins[0]).toBe(3)
    expect(agg.colour?.count).toBe(2)
  })

  it('compares two aggregates colour-to-colour first, gray-to-gray second', () => {
    const a = foldAppearance(
      null,
      desc((i) => (i % 3) + 1),
    )
    const b = foldAppearance(
      null,
      desc((i) => (i % 3) + 1, true),
    )
    expect(aggregateDistance(a, a)).toBeCloseTo(0, 10)
    // Only mixed modes available: compared on value and gradient.
    expect(aggregateDistance(a, b)).toBeCloseTo(0, 10)
  })
})
