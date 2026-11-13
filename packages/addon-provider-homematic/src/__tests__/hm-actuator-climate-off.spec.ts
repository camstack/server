import {
  DeviceType,
  type DeviceContext,
  type IDeviceRuntimeState,
  type InferNativeProvider,
  climateControlCapability,
} from '@camstack/types'
import type { Homematic } from 'nodehomematic'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HmActuatorDevice } from '../devices/hm-actuator-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'

const INTEGRATION_ID = 'hm_001'
const ADDRESS = '00315F298E5A18'
const CHANNEL = `${ADDRESS}:1`
const DEVICE_ID = 1501

type ClimateProvider = InferNativeProvider<typeof climateControlCapability>

function climateContext(captured: { name: string; provider: object }[]): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child() {
      return logger
    },
    withTags() {
      return logger
    },
  }
  return {
    id: DEVICE_ID,
    stableId: `hm:${INTEGRATION_ID}:${ADDRESS}-act-${CHANNEL}`,
    parentDeviceId: 1445,
    deviceMeta: {
      id: DEVICE_ID,
      stableId: `hm:${INTEGRATION_ID}:${ADDRESS}-act-${CHANNEL}`,
      addonId: 'provider-homematic',
      type: DeviceType.Climate,
      name: 'Living room thermostat',
      location: null,
      disabled: false,
      parentDeviceId: 1445,
      metadata: null,
    },
    persistedConfig: {
      address: ADDRESS,
      integrationId: INTEGRATION_ID,
      channel: CHANNEL,
      kind: 'climate',
    },
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }, provider: object) => {
      captured.push({ name: cap.name, provider })
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger,
    api: {
      deviceState: {
        getCapSlice: { query: async () => null },
      },
    },
  } as unknown as DeviceContext
}

describe('HmActuatorDevice climate OFF', () => {
  const climateSetMode = vi.fn(async () => {})
  const climateSetTemperature = vi.fn(async () => {})

  beforeEach(() => {
    climateSetMode.mockClear()
    climateSetTemperature.mockClear()
    homematicFacades.clear()
    homematicFacades.set(INTEGRATION_ID, {
      climateSetMode,
      climateSetTemperature,
      on: () => () => {},
      devices: () => [],
      customEntities: () => [],
    } as unknown as Homematic)
  })

  it('setMode heat from OFF restores the remembered target', async () => {
    const captured: { name: string; provider: object }[] = []
    const device = new HmActuatorDevice(climateContext(captured))
    const climate = captured.find((c) => c.name === 'climate-control')?.provider as ClimateProvider

    runtimeSeed(device, { mode: 'heat', target: 22.5, lastActiveMode: 'heat' })
    await climate.setMode({ deviceId: DEVICE_ID, mode: 'off' })
    expect(climateSetMode).toHaveBeenCalledWith(ADDRESS, CHANNEL, 'off')

    runtimeSeed(device, { mode: 'off', target: 4.5, lastActiveMode: 'heat' })
    await climate.setMode({ deviceId: DEVICE_ID, mode: 'heat' })
    expect(climateSetMode).toHaveBeenLastCalledWith(ADDRESS, CHANNEL, 'heat')
    expect(climateSetTemperature).toHaveBeenCalledWith(ADDRESS, CHANNEL, 22.5)
  })
})

function runtimeSeed(device: HmActuatorDevice, slice: Record<string, unknown>): void {
  const rs = (device as unknown as { runtimeState: IDeviceRuntimeState }).runtimeState
  rs.setCapState('climate-control', {
    mode: 'auto',
    availableModes: ['off', 'heat', 'auto'],
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: ['boost'],
    target: null,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: null,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
    lastFetchedAt: 0,
    ...slice,
  })
}
