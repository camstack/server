import {
  climateControlCapability,
  DeviceRole,
  DeviceType,
  lockControlCapability,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { kiaAccessoryChildren } from '../devices/kia-accessory-children.js'
import { climateStatusOf, lockStateOf } from '../kia-domain-mapping.js'
import { silentState, sportageState } from './kia-fixtures.js'

const parent = {
  name: 'Sportage',
  deviceId: 41,
  kiaVehicleId: 'veh-1',
  brokerId: 'acct',
  model: 'Sportage',
  integrationId: 'acct',
}

describe('a Kia car spawns its lock and climate accessories (D1079)', () => {
  const specs = kiaAccessoryChildren(parent)

  it('names a lock with role lock-vehicle and a climate with role climate-vehicle', () => {
    expect(specs.map((s) => [s.meta.type, s.meta.role])).toEqual([
      [DeviceType.Lock, DeviceRole.LockVehicle],
      [DeviceType.Climate, DeviceRole.ClimateVehicle],
    ])
  })

  it('links each child to the car and keeps its suffix stable', () => {
    expect(specs.map((s) => s.stableIdSuffix)).toEqual(['lock', 'climate'])
    expect(specs.every((s) => s.meta.linkDeviceId === 41)).toBe(true)
  })

  it('hands the child the vehicle id and account, and never a credential', () => {
    for (const spec of specs) {
      expect(spec.config).toMatchObject({ kiaVehicleId: 'veh-1', brokerId: 'acct', system: 'kia' })
      expect(JSON.stringify(spec.config)).not.toMatch(/pin|password/i)
    }
  })
})

describe('the accessory slices satisfy the cap runtime schemas', () => {
  const now = 1_795_340_000_000
  it('lock', () => {
    const state = lockStateOf(sportageState({ locked: true }))
    expect(state).toBe('locked')
    expect(
      lockControlCapability.runtimeState.safeParse({
        state,
        codeRequired: false,
        lastChangedAt: now,
        lastFetchedAt: now,
      }).success,
    ).toBe(true)
  })
  it('climate', () => {
    const slice = climateStatusOf(sportageState({ climateOn: true }), now)
    expect(slice).not.toBeNull()
    expect(climateControlCapability.runtimeState.safeParse(slice).success).toBe(true)
  })
  it('a car that does not say leaves both unwritten', () => {
    expect(lockStateOf(silentState())).toBeNull()
    expect(climateStatusOf(silentState(), now)).toBeNull()
  })
})
