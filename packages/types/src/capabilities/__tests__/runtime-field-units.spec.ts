/**
 * The unit walker sees a labelled reading inside a nullable object slot, so the picker offers
 * the Enpal heat pump's `heatPump.powerW` as a `W` source for a heat pump's electrical power
 * (planning#741), and never a nested field that is not a labelled reading.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EnergySystemStatusSchema } from '../energy-system.cap.js'
import { runtimeFieldUnits } from '../runtime-field-units.js'
import { runtimeFieldUnit } from '../runtime-field-unit.js'
import { readingMeta } from '../../units/quantity.js'

describe('runtimeFieldUnits', () => {
  it('walks a nullable object slot one level and keeps the dotted path', () => {
    const schema = z.object({
      level: z.number().meta(readingMeta('percentage', { label: 'Level' })),
      slot: z
        .object({
          powerW: z
            .number()
            .nullable()
            .meta(readingMeta('power', { label: 'Power' })),
          plain: z.number().nullable().meta(readingMeta('power')),
          name: z.string(),
        })
        .nullable(),
    })
    expect(runtimeFieldUnits(schema)).toEqual({ level: '%', 'slot.powerW': 'W' })
  })

  it('gives the energy system heat pump power as a W source', () => {
    const units = runtimeFieldUnits(EnergySystemStatusSchema)
    expect(units['heatPump.powerW']).toBe('W')
    expect(units['heatPump.energyKwh']).toBe('kWh')
  })

  it('serves it through the generated lookup', () => {
    expect(runtimeFieldUnit('energy-system', 'heatPump.powerW')).toBe('W')
  })
})
