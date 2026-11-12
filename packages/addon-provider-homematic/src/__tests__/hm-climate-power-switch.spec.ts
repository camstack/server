/**
 * D1042: a Homematic thermostat's on/off is its `switch`, built from
 * climate-control. Off writes mode `off`; on restores the last non-off mode.
 * Drop `registerPowerSwitch` in `registerClimateCap` and this spec fails.
 */
import {
  DeviceType,
  type DeviceContext,
  type IDeviceRuntimeState,
  type InferNativeProvider,
  switchCapability,
} from '@camstack/types'
import type { Homematic } from 'nodehomematic'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HmActuatorDevice } from '../devices/hm-actuator-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'

const INTEGRATION_ID = 'hm_001'
const ADDRESS = '00315F298E5A18'
const CHANNEL = `${ADDRESS}:1`
const DEVICE_ID = 1501

type SwitchProvider = InferNativeProvider<typeof switchCapability>

interface CapturedCap {
  readonly name: string
  readonly provider: object
}

function isSwitchProvider(value: object): value is SwitchProvider {
  return 'setState' in value && typeof value.setState === 'function'
}

function switchOf(captured: readonly CapturedCap[]): SwitchProvider | undefined {
  const found = captured.find((cap) => cap.name === 'switch')
  if (found === undefined) return undefined
  return isSwitchProvider(found.provider) ? found.provider : undefined
}

function climateContext(
  captured: CapturedCap[],
  hubSlice: Record<string, unknown> | null,
): DeviceContext {
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
        getCapSlice: { query: async () => hubSlice },
      },
    },
  } as unknown as DeviceContext
}

describe('Homematic thermostat power switch (D1042)', () => {
  const climateSetMode = vi.fn(async (_address: string, _channel: string, _mode: string) => {})

  beforeEach(() => {
    climateSetMode.mockClear()
    homematicFacades.clear()
    const facade = {
      climateSetMode,
      on: () => () => {},
      devices: () => [],
      customEntities: () => [],
    }
    homematicFacades.set(INTEGRATION_ID, facade as unknown as Homematic)
  })

  it('exposes switch, and switch on/off drives the climate mode', async () => {
    const captured: CapturedCap[] = []
    const hubSlice: Record<string, unknown> = { mode: 'off', lastActiveMode: 'heat' }
    const device = new HmActuatorDevice(climateContext(captured, hubSlice))
    expect(device).toBeInstanceOf(HmActuatorDevice)

    expect(captured.map((cap) => cap.name)).toContain('switch')
    const provider = switchOf(captured)
    expect(provider?.setState).toBeTypeOf('function')
    if (provider?.setState === undefined) return

    await provider.setState({ deviceId: DEVICE_ID, on: false })
    expect(climateSetMode).toHaveBeenCalledWith(ADDRESS, CHANNEL, 'off')

    await provider.setState({ deviceId: DEVICE_ID, on: true })
    expect(climateSetMode).toHaveBeenCalledWith(ADDRESS, CHANNEL, 'heat')
  })
})
