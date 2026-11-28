/**
 * planning#709 review: a child adopted BEFORE the battery cap existed persisted
 * `capabilities` without `battery`, and the kernel persists an accessory spec
 * only on the first spawn. Reconcile (container) and the standalone watch must
 * re-apply the derived capabilities so such a child gains the cap.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@dominevo/types'
import type { Homematic, HmCustomEntity } from 'nodehomematic'
import { beforeEach, describe, expect, it } from 'vitest'
import { HmContainerDevice } from '../devices/hm-container-device.js'
import { HmSensorDevice } from '../devices/hm-sensor-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { hmDataPoint, hmDevice } from './hm-test-fixtures.js'

const INTEGRATION_ID = 'hm_001'
const ADDRESS = '0001D3C99AB777'
const SENSOR_KEY = `sensor-${ADDRESS}:1`
const CONTAINER_ID = 5597
const CHILD_ID = 5598
const OLD_CAPS = ['motion-sensor']

function motionSensor() {
  return hmDevice({
    address: ADDRESS,
    type: 'HmIP-SMI',
    channels: [
      {
        address: `${ADDRESS}:1`,
        index: 1,
        type: 'MOTIONDETECTOR_TRANSCEIVER',
        dataPoints: [hmDataPoint({ parameter: 'MOTION', type: 'BOOL', value: false })],
      },
      {
        address: `${ADDRESS}:0`,
        index: 0,
        type: 'MAINTENANCE',
        dataPoints: [
          hmDataPoint({ parameter: 'LOW_BAT', type: 'BOOL', value: false }),
          hmDataPoint({ parameter: 'UNREACH', type: 'BOOL', value: false }),
        ],
      },
    ],
  })
}

function thermostat() {
  return hmDevice({
    address: ADDRESS,
    type: 'HmIP-eTRV-C',
    channels: [
      {
        address: `${ADDRESS}:1`,
        index: 1,
        type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        dataPoints: [],
      },
      {
        address: `${ADDRESS}:0`,
        index: 0,
        type: 'MAINTENANCE',
        dataPoints: [
          hmDataPoint({ parameter: 'LOW_BAT', type: 'BOOL', value: false }),
          hmDataPoint({ parameter: 'UNREACH', type: 'BOOL', value: false }),
        ],
      },
    ],
  })
}

function registerFacade(): void {
  const stub = {
    on: () => () => undefined,
    devices: () => [motionSensor()],
    customEntities: () => [],
  }
  homematicFacades.set(INTEGRATION_ID, stub as unknown as Homematic)
}

interface DevicesStub {
  readonly applied: Array<{ deviceId: number; config: Record<string, unknown> | undefined }>
  readonly api: DeviceContext['devices']
}

/** A kernel stand-in: persisted config per child, applyDerivedSpec records. */
function makeDevices(persistedCaps: readonly string[]): DevicesStub {
  const applied: DevicesStub['applied'] = []
  const api = {
    getChildren: async () => [
      { id: CHILD_ID, stableId: `hm:${INTEGRATION_ID}:${ADDRESS}-${SENSOR_KEY}` },
    ],
    loadConfig: async () => ({ capabilities: [...persistedCaps] }),
    applyDerivedSpec: async (deviceId: number, derived: { config?: Record<string, unknown> }) => {
      applied.push({ deviceId, config: derived.config })
    },
  }
  return { applied, api: api as unknown as DeviceContext['devices'] }
}

function makeLogger() {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeCtx(
  id: number,
  type: DeviceType,
  parentDeviceId: number | null,
  persistedConfig: Record<string, unknown>,
  devices: DeviceContext['devices'],
): DeviceContext {
  let rs: IDeviceRuntimeState | null = null
  const ctx = {
    id,
    stableId: `hm:${INTEGRATION_ID}:${id}`,
    parentDeviceId,
    deviceMeta: {
      id,
      stableId: `hm:${INTEGRATION_ID}:${id}`,
      addonId: 'provider-homematic',
      type,
      name: 'device',
      location: null,
      disabled: false,
      parentDeviceId,
      metadata: null,
    },
    persistedConfig,
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (state: IDeviceRuntimeState) => {
      rs = state
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && rs) {
        rs.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger: makeLogger(),
    api: {},
    devices,
  } as unknown as DeviceContext
  return ctx
}

beforeEach(() => {
  homematicFacades.clear()
  registerFacade()
})

const THERMO_CAPS = ['climate-control', 'battery']

function climateEntity(): HmCustomEntity {
  return {
    kind: 'climate',
    device: ADDRESS,
    channel: `${ADDRESS}:1`,
    name: 'Thermostat',
    writable: true,
    hasEvents: true,
  } as unknown as HmCustomEntity
}

describe('a non-primary child loses a battery persisted by the earlier release', () => {
  const sensorCaps = ['temperature-sensor', 'humidity-sensor']

  function useThermostat(): void {
    homematicFacades.clear()
    const stub = {
      on: () => () => undefined,
      devices: () => [thermostat()],
      customEntities: () => [climateEntity()],
    }
    homematicFacades.set(INTEGRATION_ID, stub as unknown as Homematic)
  }

  function makeThermoDevices(persistedBySensor: readonly string[]): DevicesStub {
    const applied: DevicesStub['applied'] = []
    const api = {
      getChildren: async () => [
        { id: CHILD_ID, stableId: `hm:${INTEGRATION_ID}:${ADDRESS}-sensor-${ADDRESS}:1` },
        { id: CHILD_ID + 1, stableId: `hm:${INTEGRATION_ID}:${ADDRESS}-act-${ADDRESS}:1` },
      ],
      loadConfig: async (id: number) => ({
        capabilities: id === CHILD_ID ? [...persistedBySensor] : [...THERMO_CAPS],
      }),
      applyDerivedSpec: async (deviceId: number, derived: { config?: Record<string, unknown> }) => {
        applied.push({ deviceId, config: derived.config })
      },
    }
    return { applied, api: api as unknown as DeviceContext['devices'] }
  }

  async function reconcile(devices: DevicesStub): Promise<void> {
    const container = new HmContainerDevice(
      makeCtx(
        CONTAINER_ID,
        DeviceType.Container,
        null,
        { address: ADDRESS, integrationId: INTEGRATION_ID },
        devices.api,
      ),
    )
    await container.onActivate()
    await container.removeDevice()
  }

  it('strips battery from the sensor child, leaves the primary actuator alone', async () => {
    useThermostat()
    const devices = makeThermoDevices([...sensorCaps, 'battery'])
    await reconcile(devices)
    expect(devices.applied).toHaveLength(1)
    expect(devices.applied[0]?.deviceId).toBe(CHILD_ID)
    expect(devices.applied[0]?.config?.['capabilities']).toEqual(sensorCaps)
  })

  it('is idempotent: a sensor already without battery is not re-applied', async () => {
    useThermostat()
    const devices = makeThermoDevices(sensorCaps)
    await reconcile(devices)
    expect(devices.applied).toHaveLength(0)
  })
})

describe('an already-adopted child gains battery', () => {
  it('a container reconcile re-applies the derived capabilities of a child persisted without battery', async () => {
    const devices = makeDevices(OLD_CAPS)
    const container = new HmContainerDevice(
      makeCtx(
        CONTAINER_ID,
        DeviceType.Container,
        null,
        { address: ADDRESS, integrationId: INTEGRATION_ID },
        devices.api,
      ),
    )
    await container.onActivate()
    expect(devices.applied).toHaveLength(1)
    expect(devices.applied[0]?.deviceId).toBe(CHILD_ID)
    expect(devices.applied[0]?.config?.['capabilities']).toContain('battery')
    await container.removeDevice()
  })

  it('leaves a child that already names battery alone', async () => {
    const devices = makeDevices([...OLD_CAPS, 'battery'])
    const container = new HmContainerDevice(
      makeCtx(
        CONTAINER_ID,
        DeviceType.Container,
        null,
        { address: ADDRESS, integrationId: INTEGRATION_ID },
        devices.api,
      ),
    )
    await container.onActivate()
    expect(devices.applied).toHaveLength(0)
    await container.removeDevice()
  })

  it('a standalone entity restored with the old config is re-derived too', async () => {
    const devices = makeDevices(OLD_CAPS)
    const sensor = new HmSensorDevice(
      makeCtx(
        CHILD_ID,
        DeviceType.Sensor,
        null,
        {
          address: ADDRESS,
          integrationId: INTEGRATION_ID,
          channel: `${ADDRESS}:1`,
          hmEntityKey: SENSOR_KEY,
          system: 'homematic',
          capabilities: OLD_CAPS,
        },
        devices.api,
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(devices.applied).toHaveLength(1)
    expect(devices.applied[0]?.config?.['capabilities']).toContain('battery')
    await sensor.removeDevice()
  })
})
