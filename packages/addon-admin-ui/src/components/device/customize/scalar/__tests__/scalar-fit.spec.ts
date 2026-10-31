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

  it('takes a contact for the lock door-contact (D984) and refuses a number', () => {
    const contact = scalarFieldFit('lock-control', 'door-contact', {
      cap: 'contact',
      path: 'entryOpen',
      kind: 'boolean',
      unit: null,
    })
    expect(contact.ok).toBe(true)
    expect(
      scalarFieldFit('lock-control', 'door-contact', {
        cap: 'numeric-sensor',
        path: 'value',
        kind: 'number',
        unit: null,
      }).ok,
    ).toBe(false)
  })
})
