import { describe, expect, it } from 'vitest'
import { mergeFaultTypes } from '../fault-type-options'
import {
  patchSystemEventFilters,
  systemEventFilterVisibilityFor,
} from '../notification-system-events'

describe('mergeFaultTypes', () => {
  it('unions the catalogs by code, sorted by label, severity as the hint', () => {
    const merged = mergeFaultTypes([
      [{ code: 'b', label: 'Beta', severity: 'warning' }],
      undefined,
      [
        { code: 'a', label: 'Alpha', severity: 'error' },
        { code: 'b', label: 'Other words', severity: 'error' },
      ],
    ])
    expect(merged).toEqual([
      { value: 'a', label: 'Alpha', hint: 'error' },
      { value: 'b', label: 'Beta', hint: 'warning' },
    ])
  })
})

describe('the fault-code filter in the rule editor', () => {
  it('is offered only with an attention kind', () => {
    expect(
      systemEventFilterVisibilityFor('device-events', ['device-attention-required']).faultCodes,
    ).toBe(true)
    expect(systemEventFilterVisibilityFor('device-events', ['device-offline']).faultCodes).toBe(
      false,
    )
  })

  it('keeps the codes on patch, and an empty list means any (absent)', () => {
    const base = { kinds: ['device-attention-required' as const] }
    expect(patchSystemEventFilters(base, { faultCodes: ['x'] })?.faultCodes).toEqual(['x'])
    expect(patchSystemEventFilters({ ...base, faultCodes: ['x'] }, { faultCodes: [] })).toEqual(
      base,
    )
  })
})
