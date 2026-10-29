import { describe, expect, it } from 'vitest'
import { describeBowlSource, readBowl } from '../devices/petkit-feeder-device.js'

describe('readBowl', () => {
  it('reads the D3 bowl grams from state.weight', () => {
    expect(readBowl({ weight: 61, eating: 0 })).toMatchObject({ value: 61, source: 'weight' })
  })
  it('never reports state.bowl as grams: its unit is unproven, so it is not a reading', () => {
    expect(readBowl({ bowl: 12 })).toEqual({
      value: null,
      source: 'bowl-unproven',
      innerKeys: ['bowl'],
    })
  })
  it('reads the weight scale even when state.bowl is also present', () => {
    expect(readBowl({ bowl: 12, weight: 61 })).toMatchObject({ value: 61, source: 'weight' })
  })
  it('is null with source "none" and lists the keys when neither is present', () => {
    expect(readBowl({ eating: 0, pim: 1 })).toEqual({
      value: null,
      source: 'none',
      innerKeys: ['eating', 'pim'],
    })
    expect(readBowl(null)).toMatchObject({ value: null, source: 'none' })
    expect(describeBowlSource(readBowl({ eating: 0, pim: 1 }))).toBe(
      'petkit feeder: bowl fed by none (state keys: eating, pim)',
    )
    expect(describeBowlSource(readBowl({ weight: 61 }))).toContain('fed by weight')
    expect(describeBowlSource(readBowl({ bowl: 12 }))).toContain('state.bowl is not read')
  })
})
