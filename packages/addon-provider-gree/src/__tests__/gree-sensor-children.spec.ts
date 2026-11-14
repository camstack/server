import {
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceRole,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GreeContainerDevice } from '../devices/gree-container-device.js'
import { GreeSensorDevice } from '../devices/gree-sensor-device.js'
import { startGreeExtrasPoll } from '../gree-extras.js'
import { greeConnections } from '../gree-gateway.js'

function stubContext(persistedConfig: Record<string, unknown>, type: DeviceType): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  return {
    id: 30,
    stableId: 'gree-aabbcc',
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'Salotto',
      location: null,
      disabled: false,
      addonId: 'gree',
      metadata: {},
    },
    persistedConfig,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
}

const KEY = 'conn-1'
const MAC = 'aabbcc'

function container(): GreeContainerDevice {
  return new GreeContainerDevice(
    stubContext(
      { greeMac: MAC, connectionKey: KEY, connection: { host: '192.0.2.10' }, system: 'gree' },
      DeviceType.Container,
    ),
  )
}

function sensorSpecs(c: GreeContainerDevice): readonly AccessoryChildSpec[] {
  const answer = c.getAccessoryChildren()
  const list = Array.isArray(answer) ? answer : []
  return list.filter((s) => s.stableIdSuffix === 'outdoor' || s.stableIdSuffix === 'error')
}

afterEach(() => greeConnections.clear())

describe('Gree sensor children declaration', () => {
  it('a unit that has not answered the columns gets no sensor child', () => {
    expect(sensorSpecs(container())).toEqual([])
  })

  it('declares "Temperatura esterna" named after the parent, as a temperature sensor', () => {
    greeConnections.setExtras(KEY, MAC, { outdoorTemp: 6, defrost: false, errorCode: 0 })
    const outdoor = sensorSpecs(container()).find((s) => s.stableIdSuffix === 'outdoor')
    expect(outdoor?.meta.name).toBe('Salotto Temperatura esterna')
    expect(outdoor?.meta.type).toBe(DeviceType.Sensor)
    expect(outdoor?.meta.role).toBe(DeviceRole.TemperatureSensor)
    expect(outdoor?.config).toMatchObject({ kind: 'outdoor', greeMac: MAC, connectionKey: KEY })
  })

  it('declares no outdoor child when only the error column answered', () => {
    greeConnections.setExtras(KEY, MAC, { outdoorTemp: null, defrost: null, errorCode: 0 })
    expect(sensorSpecs(container()).map((s) => s.stableIdSuffix)).toEqual(['error'])
  })
})

describe('GreeSensorDevice', () => {
  async function sensor(kind: 'outdoor' | 'error'): Promise<GreeSensorDevice> {
    const d = new GreeSensorDevice(
      stubContext({ kind, greeMac: MAC, connectionKey: KEY, system: 'gree' }, DeviceType.Sensor),
    )
    await d.onActivate()
    return d
  }

  it('outdoor reports the unit temperature and follows later reads', async () => {
    const d = await sensor('outdoor')
    greeConnections.setExtras(KEY, MAC, { outdoorTemp: 6, defrost: false, errorCode: 0 })
    expect(d.runtimeState.getCapState('temperature-sensor')).toMatchObject({ temperature: 6 })
    greeConnections.setExtras(KEY, MAC, { outdoorTemp: -2, defrost: false, errorCode: 0 })
    expect(d.runtimeState.getCapState('temperature-sensor')).toMatchObject({ temperature: -2 })
  })

  it('error carries the code and warns with the deviceId tag', async () => {
    const d = await sensor('error')
    greeConnections.setExtras(KEY, MAC, { outdoorTemp: 6, defrost: false, errorCode: 0 })
    expect(d.runtimeState.getCapState('enum-sensor')).toMatchObject({ value: 'ok' })
    greeConnections.setExtras(KEY, MAC, { outdoorTemp: 6, defrost: false, errorCode: 12 })
    expect(d.runtimeState.getCapState('enum-sensor')).toMatchObject({ value: 'E12' })
  })
})

describe('startGreeExtrasPoll', () => {
  it('asks for the three columns and publishes the parsed answer', async () => {
    const requestColumns = vi.fn(async () => ({ OutEnvTem: 46, Defrost: 1, AllErr: 0 }))
    const onExtras = vi.fn()
    const stop = startGreeExtrasPoll({
      ac: { requestColumns },
      intervalMs: 60_000,
      onExtras,
      onError: vi.fn(),
    })
    await vi.waitFor(() => expect(onExtras).toHaveBeenCalled())
    stop()
    expect(requestColumns).toHaveBeenCalledWith(['OutEnvTem', 'Defrost', 'AllErr'])
    expect(onExtras).toHaveBeenCalledWith({ outdoorTemp: 6, defrost: true, errorCode: 0 })
  })

  it('reports a failed read instead of throwing', async () => {
    const onError = vi.fn()
    const stop = startGreeExtrasPoll({
      ac: { requestColumns: async () => Promise.reject(new Error('timeout')) },
      intervalMs: 60_000,
      onExtras: vi.fn(),
      onError,
    })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    stop()
  })
})
