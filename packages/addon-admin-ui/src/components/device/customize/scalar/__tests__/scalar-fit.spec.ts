import { describe, expect, it } from 'vitest'
import { scalarFieldFit } from '../scalar-fit'

describe('scalarFieldFit', () => {
  it('accepts watts for running and names a voltage as the wrong unit', () => {
    expect(
      scalarFieldFit('running-state', 'running', {
        cap: 'power-meter',
        path: 'power',
        kind: 'number',
        unit: 'W',
      }).ok,
    ).toBe(true)
    const voltage = scalarFieldFit('running-state', 'running', {
      cap: 'numeric-sensor',
      path: 'voltage',
      kind: 'number',
      unit: 'V',
    })
    expect(voltage).toEqual({ ok: false, reason: 'unit' })
  })

  it('does not treat an unknown unit as watts', () => {
    expect(
      scalarFieldFit('running-state', 'running', {
        cap: 'numeric-sensor',
        path: 'value',
        kind: 'number',
        unit: null,
      }),
    ).toEqual({ ok: false, reason: 'unit-unknown' })
  })
})
