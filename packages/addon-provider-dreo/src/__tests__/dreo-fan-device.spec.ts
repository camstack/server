import { describe, expect, it, vi } from 'vitest'
import {
  DeviceFeature,
  DeviceType,
  anyAxisOscillating,
  type DeviceContext,
  type FanControlStatus,
  type HumiditySensorStatus,
  type IDeviceRuntimeState,
  type TemperatureSensorStatus,
} from '@dominevo/types'
import { settingsToDreoConfig } from '../config.js'
import { dreoConnections } from '../dreo-gateway.js'
import { DreoIntegrationManager } from '../dreo-integration-manager.js'
import { DreoFanDevice } from '../devices/dreo-fan-device.js'
import { FakeBridge, IDLE_STATE, fanDevice } from './fake-bridge.js'
import type { DreoDeviceState } from '../dreo-bridge.js'

const quiet = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
}

const CIRCULATOR: Partial<DreoDeviceState> = {
  on: true,
  speed: 8,
  speedMin: 1,
  speedMax: 8,
  oscillating: true,
  horizontalOscillating: true,
  verticalOscillating: false,
  preset: 'Auto',
  presets: ['Normal', 'Auto', 'Sleep'],
  temperature: 21.5,
}

type Registered = {
  readonly cap: { readonly name: string }
  readonly provider: Record<string, unknown>
}

async function circulator(state: Partial<DreoDeviceState> = CIRCULATOR) {
  const bridge = new FakeBridge()
  bridge.devices = [fanDevice('dev-1', state)]
  const manager = new DreoIntegrationManager({
    id: 'acct-1',
    name: 'Home',
    connection: settingsToDreoConfig({ email: 'u@example.com', password: 'p' }),
    logger: quiet as never,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    surfaceSink: dreoConnections,
    makeBridge: () => bridge,
    session: {
      register: () => undefined,
      failure: () => undefined,
      ok: async () => undefined,
    },
  })
  await manager.start()
  const registrations: Registered[] = []
  let runtime: IDeviceRuntimeState | null = null
  const ctx = {
    id: 9,
    stableId: 'dreo:test:9',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Fan,
      name: 'Fan',
      location: null,
      disabled: false,
      addonId: 'provider-dreo',
      metadata: {},
    },
    persistedConfig: {
      dreoDeviceId: 'dev-1',
      brokerId: 'acct-1',
      model: 'DR-HAF003S',
    },
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn(
      (cap: { name: string; runtimeState?: unknown }, provider: Registered['provider']) => {
        registrations.push({ cap, provider })
        if (cap.runtimeState && runtime) {
          runtime.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      },
    ),
    unregisterNativeCap: vi.fn(),
    api: {
      deviceManager: {
        registerDevice: { mutate: vi.fn(async () => ({})) },
        setMetadata: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: quiet,
  } as unknown as DeviceContext
  const device = new DreoFanDevice(ctx)
  await device.onActivate()
  return { bridge, device, registrations }
}

describe('Dreo air circulator', () => {
  it('claims speed, preset and oscillation', async () => {
    const { device } = await circulator()
    expect(device.features).toEqual(
      expect.arrayContaining([
        DeviceFeature.FanSpeed,
        DeviceFeature.FanPreset,
        DeviceFeature.FanOscillating,
      ]),
    )
  })

  it('reports the top level as 100% on a slider that can reach it, plus presets and both axes', async () => {
    const { device } = await circulator()
    const fan = device.runtimeState.getCapState<FanControlStatus>('fan-control')
    expect(fan?.speed).toBe(100)
    expect((fan?.percentageStep ?? 0) * 8).toBeCloseTo(100, 9)
    expect(fan?.preset).toBe('Auto')
    expect(fan?.availablePresets).toEqual(['Normal', 'Auto', 'Sleep'])
    expect(fan?.oscillationAxes?.horizontal?.oscillating).toBe(true)
    expect(fan?.oscillationAxes?.vertical?.oscillating).toBe(false)
  })

  it('sends preset and per-axis oscillation through the worker', async () => {
    const { bridge, registrations } = await circulator()
    const fan = registrations.find((r) => r.cap.name === 'fan-control')?.provider as {
      setPreset: (i: { deviceId: number; preset: string }) => Promise<void>
      setOscillationAxis: (i: {
        deviceId: number
        axis: 'horizontal' | 'vertical'
        oscillating: boolean
      }) => Promise<{ status: string }>
    }
    await fan.setPreset({ deviceId: 9, preset: 'Sleep' })
    const result = await fan.setOscillationAxis({
      deviceId: 9,
      axis: 'vertical',
      oscillating: true,
    })
    expect(result.status).toBe('applied')
    expect(bridge.commands.map((c) => c.command)).toEqual([
      { command: 'preset', value: 'Sleep' },
      { command: 'verticalOscillating', value: true },
    ])
  })

  it('exposes the temperature as a sensor binding; humidity only when the model reports it', async () => {
    const without = await circulator()
    expect(without.registrations.map((r) => r.cap.name)).toContain('temperature-sensor')
    expect(without.registrations.map((r) => r.cap.name)).not.toContain('humidity-sensor')
    expect(
      without.device.runtimeState.getCapState<TemperatureSensorStatus>('temperature-sensor')
        ?.temperature,
    ).toBe(21.5)

    const withHumidity = await circulator({ ...CIRCULATOR, humidity: 48 })
    expect(withHumidity.registrations.map((r) => r.cap.name)).toContain('humidity-sensor')
    expect(
      withHumidity.device.runtimeState.getCapState<HumiditySensorStatus>('humidity-sensor')
        ?.humidity,
    ).toBe(48)
  })

  it('a model without presets or axes stays empty', async () => {
    const { device } = await circulator({ ...IDLE_STATE })
    const fan = device.runtimeState.getCapState<FanControlStatus>('fan-control')
    expect(fan?.availablePresets).toEqual([])
    expect(fan?.oscillationAxes).toBeUndefined()
  })

  it('an unread sensor value is null, never 0 (D393)', async () => {
    const { device } = await circulator({ ...CIRCULATOR, temperature: null })
    const status = device.runtimeState.getCapState<TemperatureSensorStatus>('temperature-sensor')
    expect(status?.temperature).toBeNull()
  })

  it('registers humidity on the first reading that carries it', async () => {
    const { device, registrations } = await circulator()
    expect(registrations.map((r) => r.cap.name)).not.toContain('humidity-sensor')
    dreoConnections
      .getDevice('acct-1', 'dev-1')
      ?.update({ ...IDLE_STATE, ...CIRCULATOR, humidity: 51 })
    expect(registrations.map((r) => r.cap.name)).toContain('humidity-sensor')
    expect(device.runtimeState.getCapState<HumiditySensorStatus>('humidity-sensor')?.humidity).toBe(
      51,
    )
  })

  it('refuses an axis the model lacks, without calling the worker', async () => {
    const { bridge, registrations } = await circulator({
      ...CIRCULATOR,
      horizontalOscillating: null,
      verticalOscillating: null,
    })
    const fan = registrations.find((r) => r.cap.name === 'fan-control')?.provider as {
      setOscillationAxis: (i: {
        deviceId: number
        axis: 'horizontal'
        oscillating: boolean
      }) => Promise<{ status: string }>
    }
    const result = await fan.setOscillationAxis({
      deviceId: 9,
      axis: 'horizontal',
      oscillating: true,
    })
    expect(result.status).toBe('refused')
    expect(bridge.commands).toEqual([])
    expect(quiet.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 9 } }),
    )
  })

  it('keeps the combined flag coherent with the axes the device reports', async () => {
    const { device } = await circulator({
      ...CIRCULATOR,
      oscillating: true,
      horizontalOscillating: false,
      verticalOscillating: true,
    })
    const fan = device.runtimeState.getCapState<FanControlStatus>('fan-control')
    expect(fan?.oscillating).toBe(true)
    expect(fan === undefined ? null : anyAxisOscillating(fan)).toBe(true)
  })
})
