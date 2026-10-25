import {
  DeviceRole,
  DeviceType,
  type BinaryStatus,
  type EnumSensorStatus,
  type NumericSensorStatus,
  type PowerMeterStatus,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeConnectSensorDevice } from '../devices/home-connect-sensor-device.js'
import type { HomeConnectChildBinding } from '../home-connect-child-bindings.js'
import { homeConnectConnections } from '../home-connect-gateway.js'
import { makeDeviceCtx } from './device-ctx.js'
import { dishwasherCompactJson, HA_ID } from './dishwasher-iddf-fixture.js'
import { makeFakeClient, type FakeHomeConnectClient } from './fake-client.js'

const BROKER = 'broker-1'
const APPLIANCE = { haId: HA_ID, name: 'Kitchen DW', type: 'Dishwasher', availablePrograms: [] }

function connect(client: FakeHomeConnectClient): void {
  homeConnectConnections.set(BROKER, { appliances: [APPLIANCE], client })
}

function clientWith(features: Record<string, unknown> = {}, description = dishwasherCompactJson()) {
  return makeFakeClient({
    appliances: [APPLIANCE],
    description,
    features: { [HA_ID]: features },
  })
}

async function sensor(binding: HomeConnectChildBinding) {
  const t = makeDeviceCtx({
    id: 60,
    stableId: `home-connect:${BROKER}:${HA_ID}:${binding.stableIdSuffix}`,
    type: DeviceType.Sensor,
    parentDeviceId: 42,
    config: { haId: HA_ID, brokerId: BROKER, binding, system: 'home-connect' },
  })
  const device = new HomeConnectSensorDevice(t.ctx)
  await device.onActivate()
  return { t, device }
}

const REMAINING: HomeConnectChildBinding = {
  stableIdSuffix: 'bsh-common-option-remainingprogramtime',
  key: 'BSH.Common.Option.RemainingProgramTime',
  cap: 'numeric-sensor',
  convert: 'none',
  role: DeviceRole.NumericSensor,
  name: 'Remaining program time',
}
const DOOR_LOCKED: HomeConnectChildBinding = {
  stableIdSuffix: 'bsh-common-setting-childlock',
  key: 'BSH.Common.Setting.ChildLock',
  cap: 'binary',
  convert: 'none',
  role: DeviceRole.BinarySensor,
  name: 'Child lock',
}

afterEach(() => {
  homeConnectConnections.clear()
})

describe('HomeConnectSensorDevice — unknown is not zero', () => {
  it('a sensor the appliance has not reported has NO slice and is offline (no value:0, on:false)', async () => {
    connect(clientWith({}))
    const { t, device } = await sensor(REMAINING)
    expect(t.runtimeState().getCapState<NumericSensorStatus>('numeric-sensor')).toBeFalsy()
    expect(device.online).toBe(false)
    const provider = t.providers.get('numeric-sensor') as {
      getStatus(): Promise<NumericSensorStatus>
    }
    expect((await provider.getStatus()).lastFetchedAt).toBe(0) // the cap's "never fetched" marker
  })

  it('publishes the value the moment it arrives, in the unit of its series', async () => {
    const client = clientWith({})
    connect(client)
    const { t, device } = await sensor(REMAINING)
    client.emitFeature(HA_ID, REMAINING.key, 5400)
    expect(t.runtimeState().getCapState<NumericSensorStatus>('numeric-sensor')).toMatchObject({
      value: 5400,
      unit: 's',
    })
    expect(device.online).toBe(true)
  })

  it('a value that goes null does not become 0: the sensor goes offline and keeps the last slice as stale', async () => {
    const client = clientWith({ [REMAINING.key]: 120 })
    connect(client)
    const { t, device } = await sensor(REMAINING)
    expect(device.online).toBe(true)
    client.emitFeature(HA_ID, REMAINING.key, null)
    expect(device.online).toBe(false)
    expect(t.runtimeState().getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBe(120)
  })

  it('a dropped link takes every sensor offline', async () => {
    const client = clientWith({ [REMAINING.key]: 120 })
    connect(client)
    const { device } = await sensor(REMAINING)
    client.emitLink(HA_ID, 'disconnected')
    expect(device.online).toBe(false)
    client.emitFeature(HA_ID, REMAINING.key, 90)
    client.emitLink(HA_ID, 'connected')
    expect(device.online).toBe(true)
  })

  it('attaches to a client that appears after the sensor started, and to its replacement', async () => {
    const { t, device } = await sensor(REMAINING)
    expect(device.online).toBe(false)
    const first = clientWith({ [REMAINING.key]: 100 })
    connect(first)
    expect(t.runtimeState().getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBe(100)
    const second = clientWith({ [REMAINING.key]: 200 })
    connect(second)
    expect(t.runtimeState().getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBe(200)
    first.emitFeature(HA_ID, REMAINING.key, 1)
    expect(t.runtimeState().getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBe(200)
  })
})

describe('HomeConnectSensorDevice — the other caps', () => {
  it('binary: lastChangedAt is the time of the transition, not of every refresh', async () => {
    const client = clientWith({ [DOOR_LOCKED.key]: true })
    connect(client)
    const { t } = await sensor(DOOR_LOCKED)
    const first = t.runtimeState().getCapState<BinaryStatus>('binary')
    expect(first?.on).toBe(true)
    client.emitFeature(HA_ID, DOOR_LOCKED.key, true)
    expect(t.runtimeState().getCapState<BinaryStatus>('binary')?.lastChangedAt).toBe(
      first?.lastChangedAt,
    )
    client.emitFeature(HA_ID, DOOR_LOCKED.key, false)
    expect(t.runtimeState().getCapState<BinaryStatus>('binary')?.on).toBe(false)
  })

  it('enum sensor publishes the decoded label', async () => {
    const binding: HomeConnectChildBinding = {
      stableIdSuffix: 'bsh-common-status-doorstate',
      key: 'BSH.Common.Status.DoorState',
      cap: 'enum-sensor',
      convert: 'none',
      role: DeviceRole.EnumSensor,
      name: 'Door state',
    }
    connect(clientWith({ [binding.key]: 'Closed' }))
    const { t } = await sensor(binding)
    expect(t.runtimeState().getCapState<EnumSensorStatus>('enum-sensor')?.value).toBe('Closed')
  })

  it('a cumulative energy counter publishes kWh converted from the unit the description declares', async () => {
    const compact = dishwasherCompactJson()
    const entities = compact['entities'] as Record<string, Record<string, unknown>>
    entities['9000'] = {
      uid: 9000,
      name: 'BSH.Common.Statistic.EnergyConsumption',
      kind: 'status',
      valueType: 'number',
      unit: 'Wh',
    }
    const binding: HomeConnectChildBinding = {
      stableIdSuffix: 'bsh-common-statistic-energyconsumption',
      key: 'BSH.Common.Statistic.EnergyConsumption',
      cap: 'power-meter',
      convert: 'energy-total-kwh',
      role: DeviceRole.EnergySensor,
      name: 'Energy total',
    }
    connect(clientWith({ [binding.key]: 12_500 }, compact))
    const { t } = await sensor(binding)
    expect(t.runtimeState().getCapState<PowerMeterStatus>('power-meter')).toMatchObject({
      kwhTotal: 12.5,
      unit: 'kWh',
    })
  })
})

describe('HomeConnectSensorDevice — a child persisted before the description-derived model', () => {
  /** What the fixed-catalog build persisted: a `sensorKind`, no `binding`. */
  function legacyCtx(sensorKind: string) {
    return makeDeviceCtx({
      id: 61,
      stableId: `home-connect:${BROKER}:${HA_ID}:${sensorKind}`,
      type: DeviceType.Sensor,
      parentDeviceId: 42,
      config: { haId: HA_ID, brokerId: BROKER, sensorKind, system: 'home-connect' },
    })
  }

  it('restores (never throws) and reads the key its old kind named', async () => {
    const client = clientWith({ 'BSH.Common.Option.EnergyForecast': 60 })
    connect(client)
    const t = legacyCtx('energy-forecast')
    const device = new HomeConnectSensorDevice(t.ctx)
    await device.onActivate()
    expect(t.providers.has('numeric-sensor')).toBe(true)
    expect(t.runtimeState().getCapState<NumericSensorStatus>('numeric-sensor')?.value).toBe(60)
    expect(device.online).toBe(true)
  })

  it('a row with neither a binding nor a known kind is still refused', () => {
    const t = legacyCtx('not-a-kind')
    expect(() => new HomeConnectSensorDevice(t.ctx)).toThrow()
  })
})
