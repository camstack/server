/**
 * The events a "device event" trigger offers are the ones the cap vocabulary
 * declares for the picked device — never the whole EventCategory enum.
 */
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  declaredEventOptions,
  eventSelectOptions,
  fleetEventOptions,
} from '../event-category-options'

describe('declaredEventOptions', () => {
  it('lists the events the device caps declare, labelled for the locale', () => {
    const options = declaredEventOptions(['doorbell', 'battery'], 'doorbell', 'en')
    const values = options.map((o) => o.value)
    expect(values).toContain('doorbell.onPressed')
    expect(values).toContain('device.awake')
    expect(options.every((o) => o.label.length > 0)).toBe(true)
  })

  it('a device whose caps declare no event gets none, not the global list', () => {
    expect(declaredEventOptions(['switch'], 'light', 'en')).toEqual([])
    expect(declaredEventOptions([], undefined, 'en')).toEqual([])
  })

  it('offers each category once and never one outside the vocabulary', () => {
    const values = declaredEventOptions(
      ['doorbell', 'battery', 'device-status'],
      undefined,
      'en',
    ).map((o) => o.value)
    expect(new Set(values).size).toBe(values.length)
    expect(values.length).toBeLessThan(Object.values(EventCategory).length)
  })
})

describe('fleetEventOptions (a trigger with no device)', () => {
  it('is the union of what the vocabulary declares, a strict subset of the enum', () => {
    const values = fleetEventOptions('en').map((o) => o.value)
    expect(values).toContain('doorbell.onPressed')
    expect(values.length).toBeGreaterThan(0)
    expect(values.length).toBeLessThan(Object.values(EventCategory).length)
  })
})

describe('eventSelectOptions', () => {
  const declared = declaredEventOptions(['doorbell'], 'doorbell', 'en')

  it('keeps a stored category the device declares as it is', () => {
    const out = eventSelectOptions(declared, 'doorbell.onPressed', 'not declared')
    expect(out.map((o) => o.value)).toEqual(declared.map((o) => o.value))
  })

  it('shows a stored category the device does not declare, flagged, so the row stays truthful', () => {
    const out = eventSelectOptions(declared, 'motion.on-motion-changed', 'not declared')
    const stored = out.find((o) => o.value === 'motion.on-motion-changed')
    expect(stored?.label).toContain('not declared')
    expect(out).toHaveLength(declared.length + 1)
  })

  it('adds nothing for an empty stored category', () => {
    expect(eventSelectOptions(declared, '', 'not declared')).toEqual(declared)
  })
})
