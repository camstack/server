import { DeviceRole, DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeConnectApplianceDevice } from '../devices/home-connect-appliance-device.js'
import { deriveChildBindings } from '../home-connect-child-bindings.js'
import { homeConnectConnections } from '../home-connect-gateway.js'
import { makeDeviceCtx } from './device-ctx.js'
import { dishwasherCompactJson, dishwasherDescription, HA_ID } from './dishwasher-iddf-fixture.js'
import { makeFakeClient } from './fake-client.js'

const BROKER = 'broker-1'
const APPLIANCE = { haId: HA_ID, name: 'Kitchen', type: 'Dishwasher', availablePrograms: [] }

function container(entities: readonly unknown[]) {
  return makeDeviceCtx({
    id: 42,
    stableId: `home-connect:${BROKER}:${HA_ID}:appliance`,
    type: DeviceType.Container,
    name: 'Kitchen',
    config: {
      haId: HA_ID,
      brokerId: BROKER,
      applianceType: 'Dishwasher',
      entities,
      system: 'home-connect',
    },
  })
}

afterEach(() => {
  homeConnectConnections.clear()
})

describe('HomeConnectApplianceDevice.getAccessoryChildren', () => {
  const entities = deriveChildBindings({
    description: dishwasherDescription(),
    features: new Map<string, unknown>([['BSH.Common.Setting.ChildLock', false]]),
  })

  it('fans out the dishwasher, the events emitter and one sensor per bound entity', () => {
    const device = new HomeConnectApplianceDevice(container(entities).ctx)
    const specs = device.getAccessoryChildren()
    expect(specs.map((s) => s.meta.type).filter((t) => t === DeviceType.Dishwasher)).toHaveLength(1)
    expect(specs.find((s) => s.stableIdSuffix === 'events')?.meta.type).toBe(
      DeviceType.EventEmitter,
    )
    const sensors = specs.filter((s) => s.meta.type === DeviceType.Sensor)
    expect(sensors).toHaveLength(entities.length)
    expect(sensors.map((s) => s.stableIdSuffix).sort()).toEqual(
      entities.map((e) => e.stableIdSuffix).sort(),
    )
    const dishwasher = specs.find((s) => s.meta.type === DeviceType.Dishwasher)
    expect(dishwasher?.stableIdSuffix).toBe('dishwasher')
    expect(dishwasher?.meta.name).toBe('Dishwasher Kitchen')
  })

  it('each sensor child carries its binding and the role the binding chose', () => {
    const device = new HomeConnectApplianceDevice(container(entities).ctx)
    const door = device
      .getAccessoryChildren()
      .find((s) => s.stableIdSuffix === 'bsh-common-status-doorstate')
    expect(door?.meta.role).toBe(DeviceRole.EnumSensor)
    expect(door?.meta.name).toBe('Kitchen — Door state')
    expect(door?.config).toMatchObject({
      haId: HA_ID,
      brokerId: BROKER,
      binding: { key: 'BSH.Common.Status.DoorState', cap: 'enum-sensor' },
    })
  })

  it('before the description is known there is just the dishwasher', () => {
    const device = new HomeConnectApplianceDevice(container([]).ctx)
    const specs = device.getAccessoryChildren()
    expect(specs.map((s) => s.stableIdSuffix)).toEqual(['dishwasher'])
  })

  it('no events child when the appliance declares no events', () => {
    const noEvents = entities.filter((e) => e.convert !== 'event-active')
    const specs = new HomeConnectApplianceDevice(container(noEvents).ctx).getAccessoryChildren()
    expect(specs.some((s) => s.stableIdSuffix === 'events')).toBe(false)
  })
})

describe('HomeConnectApplianceDevice — children survive the upgrade', () => {
  function legacyContainer() {
    return makeDeviceCtx({
      id: 42,
      stableId: `home-connect:${BROKER}:${HA_ID}:appliance`,
      type: DeviceType.Container,
      name: 'Kitchen',
      config: {
        haId: HA_ID,
        brokerId: BROKER,
        children: [
          { role: 'dishwasher', stableIdSuffix: 'dishwasher', name: 'Dishwasher Kitchen' },
          {
            role: 'energy-forecast',
            stableIdSuffix: 'energy-forecast',
            name: 'Kitchen — Energy forecast',
          },
          { role: 'connectivity', stableIdSuffix: 'connectivity', name: 'Kitchen — Connectivity' },
        ],
        system: 'home-connect',
      },
    })
  }

  it('a container saved with the old fixed children keeps them until the description is read', () => {
    const specs = new HomeConnectApplianceDevice(legacyContainer().ctx).getAccessoryChildren()
    expect(specs.map((s) => s.stableIdSuffix).sort()).toEqual([
      'connectivity',
      'dishwasher',
      'energy-forecast',
    ])
  })

  it('a malformed persisted row neither throws nor shrinks the other children', () => {
    const good = deriveChildBindings({
      description: dishwasherDescription(),
      features: new Map<string, unknown>(),
    })
    const specs = new HomeConnectApplianceDevice(
      container([...good, { garbage: true }]).ctx,
    ).getAccessoryChildren()
    expect(specs.filter((s) => s.meta.type === DeviceType.Sensor)).toHaveLength(good.length)
  })
})

describe('HomeConnectApplianceDevice — online and device info', () => {
  it('is offline until the link is up and follows it afterwards', async () => {
    const t = container([])
    const device = new HomeConnectApplianceDevice(t.ctx)
    await device.onActivate()
    expect(device.online).toBe(false)
    const client = makeFakeClient({
      appliances: [APPLIANCE],
      description: dishwasherCompactJson(),
      link: 'connected',
    })
    homeConnectConnections.set(BROKER, { appliances: [APPLIANCE], client })
    expect(device.online).toBe(true)
    client.emitLink(HA_ID, 'disconnected')
    expect(device.online).toBe(false)
  })

  it('publishes /ci/info as device metadata, once per change', async () => {
    const t = container([])
    const device = new HomeConnectApplianceDevice(t.ctx)
    await device.onActivate()
    const client = makeFakeClient({
      appliances: [APPLIANCE],
      description: dishwasherCompactJson(),
      link: 'connected',
    })
    homeConnectConnections.set(BROKER, { appliances: [APPLIANCE], client })
    client.emitFeature(HA_ID, 'HomeConnect.Info.brand', 'Bosch')
    client.emitFeature(HA_ID, 'HomeConnect.Info.vib', 'SMV4HCX48E/01')
    client.emitFeature(HA_ID, 'HomeConnect.Info.softwareVersion', '3.1.2')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const last = t.metadataPatches.at(-1)
    expect(last).toMatchObject({
      manufacturer: 'Bosch',
      model: 'SMV4HCX48E/01',
      firmware: '3.1.2',
    })
    const before = t.metadataPatches.length
    client.emitFeature(HA_ID, 'HomeConnect.Info.brand', 'Bosch')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.metadataPatches).toHaveLength(before)
  })
})
