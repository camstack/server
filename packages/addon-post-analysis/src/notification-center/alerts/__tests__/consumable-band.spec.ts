import { describe, expect, it } from 'vitest'
import {
  CONSUMABLE_LOW_HYSTERESIS_PCT,
  deriveConsumableBand,
  type NcConsumableBand,
} from '../consumable-band.js'

function band(
  reading: { level: number | null; status: 'ok' | 'replace' | null },
  previous?: NcConsumableBand,
): NcConsumableBand | null {
  return deriveConsumableBand({
    reading,
    thresholdPercent: 20,
    ...(previous === undefined ? { previous: undefined } : { previous }),
  })
}

describe('deriveConsumableBand — the MEASURED side', () => {
  it('is low at or under the operator’s threshold', () => {
    expect(band({ level: 20, status: null })).toBe('low')
    expect(band({ level: 5, status: null })).toBe('low')
    expect(band({ level: 21, status: null })).toBe('normal')
  })

  it('climbing out takes the threshold PLUS hysteresis', () => {
    // A level oscillating around the edge must not produce alternating pairs.
    expect(band({ level: 22, status: null }, 'low')).toBe('low')
    expect(band({ level: 20 + CONSUMABLE_LOW_HYSTERESIS_PCT, status: null }, 'low')).toBe('normal')
  })
})

describe('deriveConsumableBand — the VERDICT side', () => {
  it('a `replace` is low, with no level at all', () => {
    expect(band({ level: null, status: 'replace' })).toBe('low')
  })

  it('an `ok` with no level is normal — the provider is the only voice', () => {
    expect(band({ level: null, status: 'ok' })).toBe('normal')
  })

  it('a `replace` is never talked out of by a healthy percentage', () => {
    // The provider reached a verdict. A mop pad reported missing is missing,
    // whatever a life-remaining number says.
    expect(band({ level: 100, status: 'replace' })).toBe('low')
  })

  it('a LOW level is not silenced by an `ok` verdict', () => {
    // The one place this departs from the battery rule, and deliberately: a
    // consumable can report both, the two can disagree, and silence is the
    // expensive mistake. A filter at 5 % keeps wearing whether or not its
    // provider has noticed.
    expect(band({ level: 5, status: 'ok' })).toBe('low')
  })
})

describe('deriveConsumableBand — the third answer', () => {
  it('an item that has told us NOTHING is null, not normal', () => {
    // The cap describes exactly this item: a provider may only know it exists.
    // Seeding it healthy would be a claim, and the first genuine `replace`
    // would read as a transition out of a state nobody observed.
    expect(band({ level: null, status: null })).toBeNull()
  })

  it('a non-finite level with no verdict is also nothing', () => {
    expect(band({ level: Number.NaN, status: null })).toBeNull()
  })
})
