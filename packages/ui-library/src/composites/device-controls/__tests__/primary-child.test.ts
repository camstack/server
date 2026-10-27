import { describe, it, expect } from 'vitest'
import { resolvePrimaryChild, PRIORITY } from '../primary-child'
import type { ChildRef } from '../primary-child'

const children: readonly ChildRef[] = [
  { id: 7, entityId: 'e.batt', type: 'sensor' },
  { id: 9, entityId: 'e.lock', type: 'lock' },
]

// --- Plan's 3 required cases ---

it('defaults to the highest-priority child type', () => {
  expect(resolvePrimaryChild(children, undefined)?.id).toBe(9) // lock > sensor
})

it('honors an explicit override by entityId, resolving to the numeric id', () => {
  expect(resolvePrimaryChild(children, 'e.batt')?.id).toBe(7)
})

it('falls back to default when the override entityId is gone (re-sync)', () => {
  expect(resolvePrimaryChild(children, 'e.removed')?.id).toBe(9)
})

// --- Additional edge cases ---

describe('resolvePrimaryChild — edge cases', () => {
  it('returns null for an empty children array', () => {
    expect(resolvePrimaryChild([], undefined)).toBeNull()
    expect(resolvePrimaryChild([], 'e.missing')).toBeNull()
  })

  it('override beats priority — entityId pointing to a lower-priority child still wins', () => {
    const mixed: readonly ChildRef[] = [
      { id: 1, entityId: 'e.lock', type: 'lock' },
      { id: 2, entityId: 'e.sensor', type: 'sensor' },
    ]
    // sensor is lower priority than lock, but override should still return it
    expect(resolvePrimaryChild(mixed, 'e.sensor')?.id).toBe(2)
  })

  it('types not in PRIORITY rank after all known types and preserve input order among themselves', () => {
    const unknown: readonly ChildRef[] = [
      { id: 10, entityId: 'e.foo', type: 'unknown-a' },
      { id: 11, entityId: 'e.bar', type: 'unknown-b' },
      { id: 12, entityId: 'e.sensor', type: 'sensor' },
    ]
    // sensor is in PRIORITY, should rank before unknowns
    expect(resolvePrimaryChild(unknown, undefined)?.id).toBe(12)
  })

  it('unknown types among themselves preserve input order (stable sort)', () => {
    const unknown: readonly ChildRef[] = [
      { id: 10, entityId: 'e.foo', type: 'unknown-a' },
      { id: 11, entityId: 'e.bar', type: 'unknown-b' },
    ]
    expect(resolvePrimaryChild(unknown, undefined)?.id).toBe(10)
  })

  it('tie/multiple same-priority children returns the first in input order', () => {
    const tied: readonly ChildRef[] = [
      { id: 3, entityId: 'e.switch1', type: 'switch' },
      { id: 4, entityId: 'e.switch2', type: 'switch' },
    ]
    expect(resolvePrimaryChild(tied, undefined)?.id).toBe(3)
  })

  it('does not mutate the input children array', () => {
    const mutable: ChildRef[] = [
      { id: 7, entityId: 'e.batt', type: 'sensor' },
      { id: 9, entityId: 'e.lock', type: 'lock' },
    ]
    const originalOrder = mutable.map((c) => c.id)
    resolvePrimaryChild(mutable, undefined)
    expect(mutable.map((c) => c.id)).toEqual(originalOrder)
  })

  it('PRIORITY array mirrors PARENT_TYPE_PRIORITY (actuators above switch, sensor last)', () => {
    expect(PRIORITY).toEqual([
      'media-player',
      'alarm-panel',
      'thermostat',
      'climate',
      'humidifier',
      'water-heater',
      'lock',
      'cover',
      'valve',
      'fan',
      'vacuum',
      'lawn-mower',
      'washer',
      'dryer',
      'dishwasher',
      'light',
      'switch',
      'siren',
      'button',
      'control',
      'notifier',
      'script',
      'automation',
      'update',
      'presence',
      'weather',
      'image',
      'sensor',
    ])
  })

  it('primary control surfaces outrank a switch (fan/cover/thermostat beat switch)', () => {
    const fanWithSwitches: readonly ChildRef[] = [
      { id: 1, entityId: 'e.osc-h', type: 'switch' },
      { id: 2, entityId: 'e.fan', type: 'fan' },
      { id: 3, entityId: 'e.osc-v', type: 'switch' },
    ]
    expect(resolvePrimaryChild(fanWithSwitches, undefined)?.id).toBe(2) // fan, not a switch
    expect(
      resolvePrimaryChild(
        [
          { id: 4, entityId: 'e.sw', type: 'switch' },
          { id: 5, entityId: 'e.cover', type: 'cover' },
        ],
        undefined,
      )?.id,
    ).toBe(5) // cover beats switch
  })

  // Regression: an HA climate entity maps to DeviceType.Thermostat ('thermostat',
  // NOT 'climate'), so the child's `type` is 'thermostat'. A container exposing a
  // climate + a switch (e.g. "Climatizzatore hall") must link the thermostat as
  // primary, not the switch. The earlier PRIORITY used the string 'climate', which
  // never matched 'thermostat' → it ranked below 'switch' and the switch won.
  it("a climate child (DeviceType.Thermostat = 'thermostat') outranks a switch", () => {
    const climateWithSwitch: readonly ChildRef[] = [
      { id: 900, entityId: 'switch.climatizzatore_hall', type: 'switch' },
      { id: 917, entityId: 'climate.climatizzatore_hall', type: 'thermostat' },
    ]
    expect(resolvePrimaryChild(climateWithSwitch, undefined)?.id).toBe(917) // thermostat, not switch
  })

  // A native air-conditioner is DeviceType.Climate ('climate'). The Gree
  // container exposes a climate child + 4 auxiliary switches (Light / X-Fan /
  // Health / Fresh Air). Before 'climate' was added to PRIORITY the auto-pick
  // fell through to a switch. It must now link the climate child as primary.
  it("an AC child (DeviceType.Climate = 'climate') outranks its auxiliary switches", () => {
    const acWithSwitches: readonly ChildRef[] = [
      { id: 526, entityId: 'gree.light', type: 'switch' },
      { id: 525, entityId: 'gree.climate', type: 'climate' },
      { id: 527, entityId: 'gree.xfan', type: 'switch' },
      { id: 528, entityId: 'gree.health', type: 'switch' },
    ]
    expect(resolvePrimaryChild(acWithSwitches, undefined)?.id).toBe(525) // climate, not a switch
  })

  // Same root cause as climate: every actuator DeviceType whose string value
  // was absent from PRIORITY ranked below `switch` and lost. Each must now beat
  // a co-located power switch. Values are the real DeviceType enum strings.
  it.each([
    ['humidifier', 'humidifier'],
    ['water-heater', 'water-heater'],
    ['valve', 'valve'],
    ['media-player', 'media-player'],
    ['alarm-panel', 'alarm-panel'],
    ['vacuum', 'vacuum'],
    ['lawn-mower', 'lawn-mower'],
  ])('a %s child outranks a co-located switch', (_label, type) => {
    const actuatorWithSwitch: readonly ChildRef[] = [
      { id: 1, entityId: 'switch.power', type: 'switch' },
      { id: 2, entityId: `e.${type}`, type },
    ]
    expect(resolvePrimaryChild(actuatorWithSwitch, undefined)?.id).toBe(2)
  })

  // siren is a switch-family actuator and deliberately ranks BELOW switch
  // (mirrors PARENT_TYPE_PRIORITY) — a switch + siren container links the switch.
  it('a switch outranks a siren (siren is switch-family, ranks lower)', () => {
    const switchAndSiren: readonly ChildRef[] = [
      { id: 1, entityId: 'siren.alarm', type: 'siren' },
      { id: 2, entityId: 'switch.power', type: 'switch' },
    ]
    expect(resolvePrimaryChild(switchAndSiren, undefined)?.id).toBe(2)
  })
})
