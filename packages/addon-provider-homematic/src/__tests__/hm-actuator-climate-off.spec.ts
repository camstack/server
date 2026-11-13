import {
  DeviceType,
  type ClimateControlStatus,
  type DeviceContext,
  type IDeviceRuntimeState,
  type InferNativeProvider,
  climateControlCapability,
} from '@camstack/types'
import type { HmCustomEntity, HmDevice, Homematic } from 'nodehomematic'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HmActuatorDevice } from '../devices/hm-actuator-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import type { HmClimateMode } from '../homematic-decode.js'
import { RecordingLogger } from './recording-logger.js'

const INTEGRATION_ID = 'hm_001'
const ADDRESS = '00315F298E5A18'
const CHANNEL = `${ADDRESS}:1`
const DEVICE_ID = 1501

type ClimateProvider = InferNativeProvider<typeof climateControlCapability>

/**
 * The methods `HmActuatorDevice` climate calls on the live facade. A real
 * `Homematic` satisfies this; the spec hands in only these methods.
 */
type ClimateOffFacade = Pick<
  Homematic,
  'on' | 'devices' | 'customEntities' | 'climateSetMode' | 'climateSetTemperature'
>

function isHomematic(value: ClimateOffFacade): value is Homematic {
  return (
    typeof value.on === 'function' &&
    typeof value.devices === 'function' &&
    typeof value.customEntities === 'function' &&
    typeof value.climateSetMode === 'function' &&
    typeof value.climateSetTemperature === 'function'
  )
}

function installFacade(facade: ClimateOffFacade): void {
  if (!isHomematic(facade)) {
    throw new Error('climate spec facade is missing a method the actuator calls')
  }
  homematicFacades.set(INTEGRATION_ID, facade)
}

function isClimateProvider(value: object): value is ClimateProvider {
  return 'setMode' in value && typeof value.setMode === 'function'
}

interface CapturedCap {
  readonly name: string
  readonly provider: object
}

function climateOf(captured: readonly CapturedCap[]): ClimateProvider {
  const found = captured.find((cap) => cap.name === 'climate-control')
  if (found === undefined || !isClimateProvider(found.provider)) {
    throw new Error('climate-control provider was not registered')
  }
  return found.provider
}

function climateContext(captured: CapturedCap[], logger: DeviceContext['logger']): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
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

const silentLogger: DeviceContext['logger'] = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return silentLogger
  },
  withTags() {
    return silentLogger
  },
}

describe('HmActuatorDevice climate OFF', () => {
  const climateSetMode = vi.fn(
    async (_device: string, _channel: string | number, _mode: HmClimateMode): Promise<void> => {},
  )
  const climateSetTemperature = vi.fn(
    async (_device: string, _channel: string | number, _temperature: number): Promise<void> => {},
  )

  beforeEach(() => {
    climateSetMode.mockClear()
    climateSetTemperature.mockClear()
    homematicFacades.clear()
    const facade: ClimateOffFacade = {
      climateSetMode,
      climateSetTemperature,
      on: () => () => undefined,
      devices: (): HmDevice[] => [],
      customEntities: (): HmCustomEntity[] => [],
    }
    installFacade(facade)
  })

  it('setMode heat from OFF restores the remembered target', async () => {
    const captured: CapturedCap[] = []
    const device = new HmActuatorDevice(climateContext(captured, silentLogger))
    const climate = climateOf(captured)

    runtimeSeed(device, { mode: 'heat', target: 22.5, lastActiveMode: 'heat' })
    await climate.setMode({ deviceId: DEVICE_ID, mode: 'off' })
    expect(climateSetMode).toHaveBeenCalledWith(ADDRESS, CHANNEL, 'off')

    runtimeSeed(device, { mode: 'off', target: 4.5, lastActiveMode: 'heat' })
    await climate.setMode({ deviceId: DEVICE_ID, mode: 'heat' })
    expect(climateSetMode).toHaveBeenLastCalledWith(ADDRESS, CHANNEL, 'heat')
    expect(climateSetTemperature).toHaveBeenCalledWith(ADDRESS, CHANNEL, 22.5)
  })

  it('setMode auto from OFF does not write a setpoint', async () => {
    const captured: CapturedCap[] = []
    const device = new HmActuatorDevice(climateContext(captured, silentLogger))
    const climate = climateOf(captured)

    runtimeSeed(device, { mode: 'auto', target: 21, lastActiveMode: 'auto' })
    await climate.setMode({ deviceId: DEVICE_ID, mode: 'off' })

    runtimeSeed(device, { mode: 'off', target: 4.5, lastActiveMode: 'auto' })
    await climate.setMode({ deviceId: DEVICE_ID, mode: 'auto' })
    expect(climateSetMode).toHaveBeenLastCalledWith(ADDRESS, CHANNEL, 'auto')
    expect(climateSetTemperature).not.toHaveBeenCalled()
  })

  it('SET_POINT_MODE 3 keeps the previous mode and logs at debug', () => {
    const logger = new RecordingLogger()
    homematicFacades.clear()
    const seeded: HmDevice = {
      address: ADDRESS,
      type: 'HMIP-WTH',
      channels: [
        {
          address: CHANNEL,
          index: 1,
          dataPoints: [
            {
              id: `${INTEGRATION_ID}:${CHANNEL}:VALUES:SET_POINT_MODE`,
              parameter: 'SET_POINT_MODE',
              type: 'INTEGER',
              value: 3,
              readable: true,
              writable: true,
              hasEvents: true,
            },
          ],
        },
      ],
    }
    const facade: ClimateOffFacade = {
      climateSetMode,
      climateSetTemperature,
      on: () => () => undefined,
      devices: () => [seeded],
      customEntities: (): HmCustomEntity[] => [],
    }
    installFacade(facade)
    const device = new HmActuatorDevice(climateContext([], logger))

    expect(device.runtimeState.getCapState<ClimateControlStatus>('climate-control')?.mode).toBe(
      'auto',
    )
    const dropped = logger.lines.find((line) => line.message.includes('SET_POINT_MODE'))
    expect(dropped?.level).toBe('debug')
    expect(dropped?.tags).toEqual({ deviceId: DEVICE_ID })
  })
})

function runtimeSeed(device: HmActuatorDevice, slice: Partial<ClimateControlStatus>): void {
  device.runtimeState.setCapState('climate-control', {
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
