import { describe, expect, it } from 'vitest'
import { describeBowlSource, readBowl } from '../devices/petkit-feeder-device.js'

describe('readBowl', () => {
  it('reads the D3 bowl grams from state.weight', () => {
    expect(readBowl({ weight: 61, eating: 0 })).toMatchObject({ value: 61, source: 'weight' })
  })
  it('prefers state.bowl when present', () => {
    expect(readBowl({ bowl: 12, weight: 61 })).toMatchObject({ value: 12, source: 'bowl' })
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
  })
})
