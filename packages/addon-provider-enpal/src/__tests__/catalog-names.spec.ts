/**
 * The house meter and the heat pump meter used to share the name "Consumption",
 * so a 1.1 kW heat-pump reading was read as the house. The ids stay; the
 * labels do not. Italian lives in the addon catalogue beside the English name
 * the device is created with.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ENPAL_CONSUMPTION_NAMES, findSpec } from '../enpal-catalog.js'

function catalogLabel(file: string, key: string): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('enpal i18n catalogue is not an object')
  }
  if (!Object.hasOwn(parsed, key)) throw new Error(`missing ${key}`)
  const value: unknown = Reflect.get(parsed, key)
  if (typeof value !== 'string') throw new Error(`${key} is not a string`)
  return value
}

describe('the two consumption meters', () => {
  it('names the house and the heat pump apart, in English and Italian', () => {
    expect(findSpec('house')?.id).toBe('house')
    expect(findSpec('heatpump')?.id).toBe('heatpump')
    expect(findSpec('house')?.name).toBe(ENPAL_CONSUMPTION_NAMES.house.en)
    expect(findSpec('heatpump')?.name).toBe(ENPAL_CONSUMPTION_NAMES.heatpump.en)
    expect(ENPAL_CONSUMPTION_NAMES.house).toEqual({
      en: 'House consumption',
      it: 'Consumo casa',
    })
    expect(ENPAL_CONSUMPTION_NAMES.heatpump).toEqual({
      en: 'Heat pump consumption',
      it: 'Consumo pompa di calore',
    })
    expect(catalogLabel('../../i18n/en.json', 'catalog.house.name')).toBe(
      ENPAL_CONSUMPTION_NAMES.house.en,
    )
    expect(catalogLabel('../../i18n/it.json', 'catalog.house.name')).toBe(
      ENPAL_CONSUMPTION_NAMES.house.it,
    )
    expect(catalogLabel('../../i18n/en.json', 'catalog.heatpump.name')).toBe(
      ENPAL_CONSUMPTION_NAMES.heatpump.en,
    )
    expect(catalogLabel('../../i18n/it.json', 'catalog.heatpump.name')).toBe(
      ENPAL_CONSUMPTION_NAMES.heatpump.it,
    )
  })
})
