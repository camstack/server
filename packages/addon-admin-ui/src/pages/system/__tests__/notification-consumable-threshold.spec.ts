/**
 * D642 — the consumable threshold is a field of the RULE, authored here.
 *
 * The operator: "default 15 % ma configurabile sulla rule". The admin's
 * device-events editor shows ONE number, only while a consumable kind is
 * selected (the engine ignores it on every other kind, and a box it ignores
 * is a promise the rule does not keep), writes it as
 * `systemEvent.consumableLowPercent`, and drops it with the kinds that made it
 * meaningful.
 */
import { describe, expect, it } from 'vitest'

import {
  patchSystemEventFilters,
  pruneSystemEventForSave,
  summariseSystemEventScope,
  systemEventFilterVisibility,
  systemEventFilterVisibilityFor,
  systemEventKindGroupsFor,
  systemEventKindLabel,
  toggleSystemEventKind,
} from '../notification-system-events'

describe('when the threshold field shows', () => {
  it('only with a consumable kind selected', () => {
    expect(systemEventFilterVisibility(['device-consumable-low']).consumableThreshold).toBe(true)
    expect(systemEventFilterVisibility(['device-consumable-normal']).consumableThreshold).toBe(true)
    expect(systemEventFilterVisibility(['device-battery-low']).consumableThreshold).toBe(false)
    expect(systemEventFilterVisibility(['device-offline']).consumableThreshold).toBe(false)
  })

  it('only on a device-events rule', () => {
    expect(
      systemEventFilterVisibilityFor('device-events', ['device-consumable-low'])
        .consumableThreshold,
    ).toBe(true)
    expect(
      systemEventFilterVisibilityFor('device-events', ['device-battery-low']).consumableThreshold,
    ).toBe(false)
  })
})

describe('writing the threshold', () => {
  it('is patched onto the condition', () => {
    expect(
      patchSystemEventFilters({ kinds: ['device-consumable-low'] }, { consumableLowPercent: 25 }),
    ).toEqual({ kinds: ['device-consumable-low'], consumableLowPercent: 25 })
  })

  it('cleared, it is ABSENT — the rule judges at the default', () => {
    expect(
      patchSystemEventFilters(
        { kinds: ['device-consumable-low'], consumableLowPercent: 25 },
        { consumableLowPercent: undefined },
      ),
    ).toEqual({ kinds: ['device-consumable-low'] })
  })

  it('leaves the device filters alone, and they leave it alone', () => {
    expect(
      patchSystemEventFilters(
        { kinds: ['device-consumable-low'], consumableLowPercent: 25 },
        { excludeDeviceIds: [3615] },
      ),
    ).toEqual({
      kinds: ['device-consumable-low'],
      consumableLowPercent: 25,
      excludeDeviceIds: [3615],
    })
  })

  it('goes with the last consumable kind — never a threshold nobody can see', () => {
    const value = {
      kinds: ['device-battery-low' as const, 'device-consumable-low' as const],
      consumableLowPercent: 25,
    }
    expect(toggleSystemEventKind(value, 'device-consumable-low', 'device-events')).toEqual({
      kinds: ['device-battery-low'],
    })
    expect(pruneSystemEventForSave('device-events', value)).toEqual(value)
  })

  it('is named in the scope summary', () => {
    expect(
      summariseSystemEventScope({ kinds: ['device-consumable-low'], consumableLowPercent: 25 }),
    ).toBe('Everything · consumables at 25%')
  })
})

describe('consumables (D934)', () => {
  it('are one group — tank kinds are legacy, not offered in the editor', () => {
    const consumables = systemEventKindGroupsFor('device-events').find(
      (g) => g.id === 'consumables',
    )
    expect(consumables?.kinds.map((k) => k.value)).toEqual([
      'device-consumable-low',
      'device-consumable-normal',
    ])
    expect(systemEventKindGroupsFor('device-events').some((g) => g.id === 'tanks')).toBe(false)
  })
})
