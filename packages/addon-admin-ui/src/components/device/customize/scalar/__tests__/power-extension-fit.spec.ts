/**
 * "Power and energy" reads each reading from the device that measures it
 * (D951). A power-meter slice has no single `unit`: each field's unit is its
 * quantity's base, so the fit looks it up per field, and a reading of the
 * wrong quantity is refused by name.
 */
import { describe, expect, it } from 'vitest'
import { type ScalarFieldOffer, scalarFieldFit, scalarFieldOffers } from '../scalar-fit'

function offer(path: string, unit: string | null): ScalarFieldOffer {
  return { cap: 'power-meter', path, kind: 'number', unit }
}

describe('a power-meter field fits the target of its own quantity', () => {
  it.each([
    ['watts', 'watts', 'W'],
    ['kwhTotal', 'kwhTotal', 'kWh'],
    ['volts', 'volts', 'V'],
    ['amps', 'amps', 'A'],
  ])('target %s reads field %s in %s', (targetId, path, unit) => {
    expect(scalarFieldFit('power-meter', targetId, offer(path, unit)).ok).toBe(true)
  })

  it('refuses energy for the power target, by unit', () => {
    const verdict = scalarFieldFit('power-meter', 'watts', offer('kwhTotal', 'kWh'))
    expect(verdict).toEqual({ ok: false, reason: 'unit' })
  })

  it('offers each field with the unit its quantity is stored in', () => {
    const offers = scalarFieldOffers(
      {
        caps: [
          {
            cap: 'power-meter',
            fields: [
              { path: 'watts', kind: 'number' },
              { path: 'volts', kind: 'number' },
              { path: 'amps', kind: 'number' },
            ],
          },
        ],
      },
      null,
    )
    expect(offers.map((row) => [row.path, row.unit])).toEqual([
      ['watts', 'W'],
      ['volts', 'V'],
      ['amps', 'A'],
    ])
  })
})
