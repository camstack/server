/**
 * D1042: a Matter thermostat's on/off is its `switch`, built from
 * climate-control. Off writes mode `off`; on restores the last non-off mode.
 * Drop `registerPowerSwitch` in `registerClimateControl` and this spec fails.
 */
import {
  DeviceType,
  type DeviceContext,
  type IDeviceRuntimeState,
  type InferNativeProvider,
  switchCapability,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { MatterEndpointDevice } from '../devices/matter-endpoint-device.js'

const DEVICE_ID = 7

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
    stableId: 'matter:b1:1:1',
    parentDeviceId: null,
    deviceMeta: {
      id: DEVICE_ID,
      stableId: 'matter:b1:1:1',
      addonId: 'matter-broker',
      type: DeviceType.Climate,
      name: 'Hall thermostat',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'b1',
      nodeId: '1',
      endpointId: 1,
      capabilities: ['climate-control'],
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

describe('Matter thermostat power switch (D1042)', () => {
  const devices: MatterEndpointDevice[] = []

  afterEach(async () => {
    await Promise.all(devices.splice(0).map((device) => device.removeDevice()))
  })

  it('exposes switch, and switch on/off drives the climate mode', async () => {
    const captured: CapturedCap[] = []
    const hubSlice: Record<string, unknown> = { mode: 'off', lastActiveMode: 'heat' }
    const device = new MatterEndpointDevice(climateContext(captured, hubSlice))
    devices.push(device)
    await device.onActivate()

    expect(captured.map((cap) => cap.name)).toContain('switch')
    const provider = switchOf(captured)
    expect(provider?.setState).toBeTypeOf('function')
    if (provider?.setState === undefined) return

    await provider.setState({ deviceId: DEVICE_ID, on: false })
    expect(device.runtimeState.getCapState('climate-control')?.mode).toBe('off')

    await provider.setState({ deviceId: DEVICE_ID, on: true })
    expect(device.runtimeState.getCapState('climate-control')?.mode).toBe('heat')

    await provider.setState({ deviceId: DEVICE_ID, on: false })
    expect(device.runtimeState.getCapState('climate-control')?.mode).toBe('off')
  })
})
