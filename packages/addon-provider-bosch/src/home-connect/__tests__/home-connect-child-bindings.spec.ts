import { DeviceRole } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  childSliceFromValue,
  deriveChildBindings,
  humanizeFeatureName,
  slugFeatureKey,
  type HomeConnectChildBinding,
} from '../home-connect-child-bindings.js'
import { HomeConnectDescriptionStore } from '../home-connect-description-store.js'
import { HOME_CONNECT_NETWORK_PREFIX } from '../home-connect-ws-client.js'
import { dishwasherDescription } from './dishwasher-iddf-fixture.js'

function bindingsOf(features: Record<string, unknown>) {
  return deriveChildBindings({
    description: dishwasherDescription(),
    features: new Map(Object.entries(features)),
  })
}

function byKey(bindings: readonly HomeConnectChildBinding[], key: string) {
  return bindings.find((b) => b.key === key)
}

/** A one-off description for the energy / water cases. */
function describe_(entities: Record<string, Record<string, unknown>>) {
  return new HomeConnectDescriptionStore({
    version: 2,
    info: { deviceID: 'X', deviceType: 'Dishwasher', model: 'M' },
    program: [],
    entities: Object.fromEntries(
      Object.entries(entities).map(([uid, e]) => [uid, { uid: Number(uid), ...e }]),
    ),
  })
}

describe('deriveChildBindings — everything the description declares is exposed', () => {
  const all = bindingsOf({
    'BSH.Common.Status.BackendConnected': true,
    'BSH.Common.Status.RemoteControlStartAllowed': false,
    'BSH.Common.Setting.ChildLock': false,
    'Dishcare.Dishwasher.Option.ExtraDry': true,
  })

  it('binds statuses, settings, options and events by value type', () => {
    expect(byKey(all, 'BSH.Common.Status.OperationState')).toMatchObject({ cap: 'enum-sensor' })
    expect(byKey(all, 'BSH.Common.Status.DoorState')).toMatchObject({ cap: 'enum-sensor' })
    expect(byKey(all, 'BSH.Common.Setting.PowerState')).toMatchObject({ cap: 'enum-sensor' })
    expect(byKey(all, 'BSH.Common.Option.RemainingProgramTime')).toMatchObject({
      cap: 'numeric-sensor',
    })
    expect(byKey(all, 'BSH.Common.Setting.Brightness')).toMatchObject({ cap: 'numeric-sensor' })
    expect(byKey(all, 'BSH.Common.Setting.ChildLock')).toMatchObject({ cap: 'binary' })
    expect(byKey(all, 'BSH.Common.Status.RemoteControlStartAllowed')).toMatchObject({
      cap: 'binary',
    })
  })

  it('exposes events as binaries that are "on" while raised', () => {
    expect(byKey(all, 'Dishcare.Dishwasher.Event.SaltNearlyEmpty')).toMatchObject({
      cap: 'binary',
      convert: 'event-active',
    })
    expect(byKey(all, 'BSH.Common.Event.ProgramFinished')?.cap).toBe('binary')
  })

  it('gives connectivity the connectivity role', () => {
    expect(byKey(all, 'BSH.Common.Status.BackendConnected')?.role).toBe(
      DeviceRole.ConnectivitySensor,
    )
  })

  it('exposes an entity the feature mapping does not name instead of dropping it', () => {
    expect(byKey(all, 'Unmapped.0999')).toMatchObject({ cap: 'numeric-sensor' })
    expect(byKey(all, 'Unmapped.0998')).toBeUndefined() // type unknown until a value shows it
    const withValue = bindingsOf({ 'Unmapped.0998': true })
    expect(byKey(withValue, 'Unmapped.0998')).toMatchObject({ cap: 'binary' })
  })

  it('leaves commands and program selection to the dishwasher device', () => {
    const keys = all.map((b) => b.key)
    expect(keys.some((k) => k.includes('.Command.'))).toBe(false)
    expect(keys.some((k) => k.includes('.Program.'))).toBe(false)
    expect(keys).not.toContain('BSH.Common.Root.ActiveProgram')
    expect(keys).not.toContain('BSH.Common.Root.SelectedProgram')
  })

  it('has stable, key-derived identities (not uids, which differ per model)', () => {
    expect(byKey(all, 'BSH.Common.Status.DoorState')?.stableIdSuffix).toBe(
      'bsh-common-status-doorstate',
    )
    expect(slugFeatureKey('Unmapped.0999')).toBe('unmapped-0999')
    expect(new Set(all.map((b) => b.stableIdSuffix)).size).toBe(all.length)
  })

  it('names children for people', () => {
    expect(byKey(all, 'BSH.Common.Status.DoorState')?.name).toBe('Door state')
    expect(byKey(all, 'BSH.Common.Option.StartInRelative')?.name).toBe('Delayed start')
    expect(humanizeFeatureName('RemoteControlStartAllowed')).toBe('Remote control start allowed')
  })

  it('exposes the /ci and /ni fields the appliance sent, with a unit for signal strength', () => {
    const withInfo = bindingsOf({
      'HomeConnect.Info.vib': 'SMV4HCX48E/01',
      [`${HOME_CONNECT_NETWORK_PREFIX}rssi`]: -61,
      [`${HOME_CONNECT_NETWORK_PREFIX}ssid`]: 'home',
    })
    expect(byKey(withInfo, 'HomeConnect.Info.vib')).toMatchObject({ cap: 'enum-sensor' })
    expect(byKey(withInfo, `${HOME_CONNECT_NETWORK_PREFIX}rssi`)).toMatchObject({
      cap: 'numeric-sensor',
      unit: 'dBm',
    })
    expect(byKey(withInfo, `${HOME_CONNECT_NETWORK_PREFIX}ssid`)).toMatchObject({
      cap: 'enum-sensor',
    })
  })
})

describe('energy and water — one key per child, units from the description', () => {
  const description = describe_({
    '1': {
      name: 'BSH.Common.Statistic.EnergyConsumption',
      kind: 'status',
      unit: 'Wh',
      valueType: 'number',
    },
    '2': {
      name: 'BSH.Common.Option.EnergyConsumption',
      kind: 'option',
      unit: 'Wh',
      valueType: 'number',
    },
    '3': {
      name: 'BSH.Common.Option.WaterConsumption',
      kind: 'option',
      unit: 'l',
      valueType: 'number',
    },
    '4': {
      name: 'BSH.Common.Option.EnergyForecast',
      kind: 'option',
      valueType: 'number',
      min: 0,
      max: 100,
    },
    '5': {
      name: 'BSH.Common.Option.WaterForecast',
      kind: 'option',
      valueType: 'number',
      min: 0,
      max: 100,
    },
  })
  const features = new Map<string, unknown>([
    ['BSH.Common.Statistic.EnergyConsumption', 12_500],
    ['BSH.Common.Option.EnergyConsumption', 740],
    ['BSH.Common.Option.WaterConsumption', 9.5],
  ])
  const bindings = deriveChildBindings({ description, features })

  it('the cumulative counter is a power meter, the per-cycle figure a separate gauge', () => {
    const total = byKey(bindings, 'BSH.Common.Statistic.EnergyConsumption')
    const cycle = byKey(bindings, 'BSH.Common.Option.EnergyConsumption')
    expect(total).toMatchObject({ cap: 'power-meter', convert: 'energy-total-kwh' })
    expect(cycle).toMatchObject({ cap: 'numeric-sensor', convert: 'none' })
    expect(total?.stableIdSuffix).not.toBe(cycle?.stableIdSuffix)
    expect(total?.name).toBe('Energy total')
    expect(cycle?.name).toBe('Energy used (cycle)')
  })

  it('each child reads its OWN key — the other one cannot shadow it', () => {
    const total = byKey(bindings, 'BSH.Common.Statistic.EnergyConsumption')
    const cycle = byKey(bindings, 'BSH.Common.Option.EnergyConsumption')
    if (!total || !cycle) throw new Error('bindings missing')
    const totalSlice = childSliceFromValue({
      binding: total,
      entity: description.entityByName(total.key),
      raw: features.get(total.key),
      nowMs: 1,
    })
    const cycleSlice = childSliceFromValue({
      binding: cycle,
      entity: description.entityByName(cycle.key),
      raw: features.get(cycle.key),
      nowMs: 1,
    })
    expect(totalSlice).toEqual({
      cap: 'power-meter',
      status: { energy: 12.5, lastFetchedAt: 1 },
    })
    expect(cycleSlice).toEqual({
      cap: 'numeric-sensor',
      status: { value: 0.74, lastFetchedAt: 1 },
    })
  })

  it('kWh stays kWh: the conversion follows the declared unit, not a guess', () => {
    const kwh = describe_({
      '1': {
        name: 'BSH.Common.Statistic.EnergyConsumption',
        kind: 'status',
        unit: 'kWh',
        valueType: 'number',
      },
    })
    const binding = deriveChildBindings({
      description: kwh,
      features: new Map([['BSH.Common.Statistic.EnergyConsumption', 12.5]]),
    })[0]
    if (!binding) throw new Error('no binding')
    expect(
      childSliceFromValue({ binding, entity: kwh.entityByName(binding.key), raw: 12.5, nowMs: 1 }),
    ).toEqual({ cap: 'power-meter', status: { energy: 12.5, lastFetchedAt: 1 } })
  })

  it('a counter whose unit is not declared is not a kWh meter — it is published raw and unitless', () => {
    const undeclared = describe_({
      '1': { name: 'BSH.Common.Statistic.EnergyConsumption', kind: 'status', valueType: 'number' },
    })
    const binding = deriveChildBindings({
      description: undeclared,
      features: new Map([['BSH.Common.Statistic.EnergyConsumption', 12_500]]),
    })[0]
    expect(binding).toMatchObject({ cap: 'numeric-sensor', name: 'Energy used (total)' })
    if (!binding) throw new Error('no binding')
    const slice = childSliceFromValue({
      binding,
      entity: undeclared.entityByName(binding.key),
      raw: 12_500,
      nowMs: 1,
    })
    expect(slice).toEqual({ cap: 'numeric-sensor', status: { value: 12_500, lastFetchedAt: 1 } })
  })

  it('water stays litres whatever the magnitude', () => {
    const water = byKey(bindings, 'BSH.Common.Option.WaterConsumption')
    if (!water) throw new Error('no water binding')
    const entity = description.entityByName(water.key)
    const small = childSliceFromValue({ binding: water, entity, raw: 9.5, nowMs: 1 })
    const large = childSliceFromValue({ binding: water, entity, raw: 20_000, nowMs: 2 })
    expect(small).toMatchObject({ status: { value: 9.5 } })
    expect(large).toMatchObject({ status: { value: 20_000 } })
  })

  it('forecasts are percentages and not energy sensors', () => {
    const energy = byKey(bindings, 'BSH.Common.Option.EnergyForecast')
    const water = byKey(bindings, 'BSH.Common.Option.WaterForecast')
    expect(energy).toMatchObject({ cap: 'numeric-sensor', role: DeviceRole.NumericSensor })
    expect(water).toMatchObject({ cap: 'numeric-sensor', role: DeviceRole.NumericSensor })
    if (!energy) throw new Error('no forecast binding')
    expect(
      childSliceFromValue({
        binding: energy,
        entity: description.entityByName(energy.key),
        raw: 69,
        nowMs: 1,
      }),
    ).toEqual({ cap: 'numeric-sensor', status: { value: 69, lastFetchedAt: 1 } })
  })
})

describe('childSliceFromValue — unknown publishes nothing', () => {
  const numeric: HomeConnectChildBinding = {
    stableIdSuffix: 'x',
    key: 'K',
    cap: 'numeric-sensor',
    convert: 'none',
    role: DeviceRole.NumericSensor,
    name: 'X',
  }

  it('undefined, null and non-numbers yield no slice rather than 0', () => {
    for (const raw of [undefined, null, 'abc', Number.NaN]) {
      expect(childSliceFromValue({ binding: numeric, entity: undefined, raw, nowMs: 1 })).toBeNull()
    }
  })

  it('a real zero is a measurement', () => {
    expect(childSliceFromValue({ binding: numeric, entity: undefined, raw: 0, nowMs: 1 })).toEqual({
      cap: 'numeric-sensor',
      status: { value: 0, lastFetchedAt: 1 },
    })
  })

  it('binary: only a boolean or a known event state counts', () => {
    const binary: HomeConnectChildBinding = { ...numeric, cap: 'binary' }
    const event: HomeConnectChildBinding = { ...binary, convert: 'event-active' }
    expect(
      childSliceFromValue({ binding: binary, entity: undefined, raw: false, nowMs: 5 }),
    ).toEqual({
      cap: 'binary',
      status: { on: false, lastChangedAt: 5 },
    })
    expect(
      childSliceFromValue({ binding: binary, entity: undefined, raw: 'maybe', nowMs: 5 }),
    ).toBeNull()
    expect(
      childSliceFromValue({ binding: event, entity: undefined, raw: 'Present', nowMs: 5 }),
    ).toMatchObject({
      status: { on: true },
    })
    expect(
      childSliceFromValue({ binding: event, entity: undefined, raw: 'Off', nowMs: 5 }),
    ).toMatchObject({
      status: { on: false },
    })
    expect(
      childSliceFromValue({ binding: event, entity: undefined, raw: 'Weird', nowMs: 5 }),
    ).toBeNull()
  })
})
