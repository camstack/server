/**
 * ONE protection policy, two config keys, never both at once.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MIN_FREE_PERCENT,
  parseProtectionValue,
  protectionHelpText,
  protectionReserveBytes,
  readLegacyMaxUsedGb,
  readProtectionPolicy,
  writeProtectionPolicy,
} from '../location-protection'

const GB = 1024 ** 3

describe('readProtectionPolicy', () => {
  it('reads a stored percentage', () => {
    expect(readProtectionPolicy({ minFreePercent: 15 })).toEqual({ unit: 'percent', value: 15 })
  })

  it('reads a stored GB reserve', () => {
    expect(readProtectionPolicy({ minFreeGb: 200 })).toEqual({ unit: 'gb', value: 200 })
  })

  it('defaults to a percentage with NO value — empty means the default', () => {
    expect(readProtectionPolicy({ basePath: '/recordings' })).toEqual({
      unit: 'percent',
      value: null,
    })
  })

  it('prefers the absolute figure when a hand-edited row carries both', () => {
    expect(readProtectionPolicy({ minFreePercent: 10, minFreeGb: 200 })).toEqual({
      unit: 'gb',
      value: 200,
    })
  })
})

describe('writeProtectionPolicy', () => {
  it('writes the percentage and CLEARS the GB key', () => {
    const next = writeProtectionPolicy(
      { basePath: '/recordings', minFreeGb: 200 },
      { unit: 'percent', value: 12 },
    )
    expect(next).toEqual({ basePath: '/recordings', minFreePercent: 12 })
  })

  it('writes the GB reserve and CLEARS the percentage key', () => {
    const next = writeProtectionPolicy(
      { basePath: '/recordings', minFreePercent: 10 },
      { unit: 'gb', value: 200 },
    )
    expect(next).toEqual({ basePath: '/recordings', minFreeGb: 200 })
  })

  it('an empty value removes both keys — back to the default', () => {
    const next = writeProtectionPolicy(
      { basePath: '/recordings', minFreePercent: 10 },
      { unit: 'percent', value: null },
    )
    expect(next).toEqual({ basePath: '/recordings' })
  })

  it('never mutates the config it was given', () => {
    const config = { basePath: '/recordings', minFreePercent: 10 }
    writeProtectionPolicy(config, { unit: 'gb', value: 5 })
    expect(config).toEqual({ basePath: '/recordings', minFreePercent: 10 })
  })

  it('leaves maxUsedGb alone — it is carried, not edited', () => {
    const next = writeProtectionPolicy({ maxUsedGb: 900 }, { unit: 'gb', value: 5 })
    expect(next['maxUsedGb']).toBe(900)
  })
})

describe('parseProtectionValue', () => {
  it('reads empty as the default, not as zero', () => {
    expect(parseProtectionValue('', 'percent')).toBeNull()
    expect(parseProtectionValue('   ', 'gb')).toBeNull()
    expect(parseProtectionValue('abc', 'gb')).toBeNull()
  })

  it('clamps a percentage to 0..100', () => {
    expect(parseProtectionValue('150', 'percent')).toBe(100)
    expect(parseProtectionValue('-4', 'percent')).toBe(0)
  })

  it('floors a GB reserve at zero and keeps it unbounded above', () => {
    expect(parseProtectionValue('-4', 'gb')).toBe(0)
    expect(parseProtectionValue('4000', 'gb')).toBe(4000)
  })
})

describe('protectionReserveBytes', () => {
  it('turns a percentage into bytes of the volume', () => {
    expect(protectionReserveBytes({ unit: 'percent', value: 10 }, 471 * GB)).toBeCloseTo(
      47.1 * GB,
      -6,
    )
  })

  it('turns GB into bytes without needing the capacity', () => {
    expect(protectionReserveBytes({ unit: 'gb', value: 200 }, null)).toBe(200 * GB)
  })

  it('falls back to the default percentage when no value is stored', () => {
    expect(protectionReserveBytes({ unit: 'percent', value: null }, 100 * GB)).toBe(
      (100 * GB * DEFAULT_MIN_FREE_PERCENT) / 100,
    )
  })

  it('honours a provider-declared default over the built-in one', () => {
    expect(protectionReserveBytes({ unit: 'percent', value: null }, 100 * GB, 5)).toBe(5 * GB)
  })

  it('has NO reserve to paint when the volume never reported a size', () => {
    expect(protectionReserveBytes({ unit: 'percent', value: 10 }, null)).toBeNull()
    expect(protectionReserveBytes({ unit: 'percent', value: 10 }, 0)).toBeNull()
  })
})

describe('protectionHelpText', () => {
  it('says what the space is for and what happens when it is reached', () => {
    const text = protectionHelpText({ unit: 'gb', value: 200 })
    expect(text).toMatch(/200 GB free/)
    expect(text).toMatch(/OLDEST data/)
    expect(text).toMatch(/another location/)
  })

  it('names the default when the operator left it empty', () => {
    expect(protectionHelpText({ unit: 'percent', value: null })).toMatch(
      new RegExp(`${String(DEFAULT_MIN_FREE_PERCENT)}% of the volume \\(the default\\)`),
    )
  })
})

describe('readLegacyMaxUsedGb', () => {
  it('surfaces a stored cap so an edit does not silently drop it', () => {
    expect(readLegacyMaxUsedGb({ maxUsedGb: 900 })).toBe(900)
  })

  it('is null on every location that never had one', () => {
    expect(readLegacyMaxUsedGb({ basePath: '/recordings' })).toBeNull()
    expect(readLegacyMaxUsedGb({ maxUsedGb: 'lots' })).toBeNull()
  })
})
