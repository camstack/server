import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UNIT_PREFERENCES,
  preferenceForQuantity,
  readUnitPreferences,
} from '../unit-preferences'

describe('readUnitPreferences', () => {
  it('is metric and Celsius when nothing is stored', () => {
    expect(readUnitPreferences(undefined)).toEqual({
      value: DEFAULT_UNIT_PREFERENCES,
      parsed: true,
    })
    expect(readUnitPreferences(null).value).toEqual({
      system: 'metric',
      temperature: 'celsius',
    })
  })

  it('reads both choices', () => {
    expect(readUnitPreferences({ system: 'imperial', temperature: 'fahrenheit' })).toEqual({
      value: { system: 'imperial', temperature: 'fahrenheit' },
      parsed: true,
    })
  })

  it('fills a missing field from the default', () => {
    expect(readUnitPreferences({ system: 'imperial' })).toEqual({
      value: { system: 'imperial', temperature: 'celsius' },
      parsed: true,
    })
  })

  it('reports a field of the wrong shape as unreadable, never as the default', () => {
    expect(readUnitPreferences({ temperature: 'kelvin' }).parsed).toBe(false)
    expect(readUnitPreferences('metric').parsed).toBe(false)
    expect(readUnitPreferences([]).parsed).toBe(false)
  })
})

describe('preferenceForQuantity', () => {
  const prefs = { system: 'imperial', temperature: 'celsius' } as const
  it('takes temperature from the scale and the rest from the system', () => {
    expect(preferenceForQuantity(prefs, 'temperature')).toBe('metric')
    expect(preferenceForQuantity(prefs, 'pressure')).toBe('imperial')
    expect(
      preferenceForQuantity({ system: 'metric', temperature: 'fahrenheit' }, 'temperature'),
    ).toBe('imperial')
    expect(preferenceForQuantity(prefs, undefined)).toBe('imperial')
  })
})
