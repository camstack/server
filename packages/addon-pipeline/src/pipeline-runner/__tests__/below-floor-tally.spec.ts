/**
 * The boxes the operator's per-class floor drops are COUNTED, per class and
 * score band (D665). Until now `below-threshold` discards were carried on the
 * frame for the viewer's ghost overlay and never counted anywhere, so the
 * question "how much did the 0.65 person floor take from the tracker on 104?"
 * had no answer — 0 lines on 2026-09-27.
 */
import type { DiscardedDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { BelowFloorAccumulator, belowFloorBand, tallyBelowFloor } from '../below-floor-tally.js'

function drop(
  macroClass: string,
  score: number,
  reason: DiscardedDetection['reason'] = 'below-threshold',
): DiscardedDetection {
  return { bbox: [0, 0, 10, 10], macroClass, score, reason }
}

describe('belowFloorBand', () => {
  it('bands on the low-score continuation floor (0.35) and the person default (0.65)', () => {
    expect(belowFloorBand(0.05)).toBe('<0.35')
    expect(belowFloorBand(0.349)).toBe('<0.35')
    expect(belowFloorBand(0.35)).toBe('0.35-0.50')
    expect(belowFloorBand(0.5)).toBe('0.50-0.65')
    expect(belowFloorBand(0.649)).toBe('0.50-0.65')
    expect(belowFloorBand(0.65)).toBe('>=0.65')
  })
})

describe('tallyBelowFloor', () => {
  it('counts only below-threshold discards, per class and band', () => {
    const tally = tallyBelowFloor([
      drop('person', 0.4),
      drop('person', 0.45),
      drop('person', 0.6),
      drop('animal', 0.2),
      drop('vehicle', 0.62, 'full-frame-guard'),
      drop('person', 0.9, 'class-filter'),
    ])
    expect(tally).toEqual({
      person: { '0.35-0.50': 2, '0.50-0.65': 1 },
      animal: { '<0.35': 1 },
    })
  })

  it('a frame that dropped nothing tallies nothing', () => {
    expect(tallyBelowFloor(undefined)).toEqual({})
    expect(tallyBelowFloor([drop('person', 0.3, 'zone-gate')])).toEqual({})
  })
})

describe('BelowFloorAccumulator', () => {
  it('sums frame tallies and drains to empty', () => {
    const acc = new BelowFloorAccumulator()
    acc.add(7, tallyBelowFloor([drop('person', 0.4)]))
    acc.add(7, tallyBelowFloor([drop('person', 0.41), drop('person', 0.55)]))
    acc.add(8, tallyBelowFloor([drop('animal', 0.1)]))
    expect(acc.drain(7)).toEqual({ person: { '0.35-0.50': 2, '0.50-0.65': 1 } })
    expect(acc.drain(7)).toEqual({})
    expect(acc.drain(8)).toEqual({ animal: { '<0.35': 1 } })
  })
})
