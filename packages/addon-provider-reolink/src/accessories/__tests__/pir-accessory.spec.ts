/**
 * The PIR switch on a battery camera: a sleeping battery camera answers every
 * Baichuan request with a 400 and an empty body, so an operator write wakes it
 * first and never sends the write into a camera that stayed asleep.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { PirAccessory } from '../pir.js'

interface SwitchProvider {
  setState(input: { deviceId: number; on: boolean }): Promise<void>
}

interface PirApiFake {
  setPirInfo: (...args: unknown[]) => Promise<void>
  getPirInfo?: (...args: unknown[]) => Promise<unknown>
}

function build(
  wake: () => Promise<boolean>,
  apiOverride?: PirApiFake,
  config?: Record<string, unknown>,
) {
  let runtime: IDeviceRuntimeState | null = null
  const providers: { switch?: SwitchProvider } = {}
  const calls: string[] = []
  const setPirInfo = vi.fn(async () => {
    calls.push('setPirInfo')
  })
  const ctx = {
    id: 41,
    stableId: 'reolink-pir',
    parentDeviceId: 40,
    deviceMeta: {
      type: DeviceType.Switch,
      name: 'PIR',
      location: null,
      disabled: false,
      addonId: 'provider-reolink',
      metadata: {},
    },
    persistedConfig: { kind: 'pir-sensor', channel: 0, ...config },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }, provider: unknown) => {
      Object.assign(providers, { [cap.name]: provider })
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    api: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
  const parent = {
    name: 'cam',
    ensureApi: async () => apiOverride ?? { setPirInfo },
    wakeForWrite: async () => {
      calls.push('wake')
      return wake()
    },
  }
  const device = new PirAccessory(ctx, parent)
  return { device, providers, setPirInfo, calls, ctx }
}

describe('Reolink PIR accessory — writes to a battery camera', () => {
  it('wakes the camera before it sends the PIR write', async () => {
    const h = build(async () => true)
    await h.providers.switch!.setState({ deviceId: 41, on: true })
    expect(h.calls).toEqual(['wake', 'setPirInfo'])
  })

  it('does not send the write when the camera could not be woken, and says so', async () => {
    const h = build(async () => false)
    await expect(h.providers.switch!.setState({ deviceId: 41, on: true })).rejects.toThrow(
      /asleep/i,
    )
    expect(h.setPirInfo).not.toHaveBeenCalled()
  })

  it('retries a 400 with only the fields getPirInfo reports, and logs the attempts', async () => {
    const sent: unknown[] = []
    const setPirInfo = vi.fn(async (payload: unknown) => {
      sent.push(payload)
      if (sent.length === 1)
        throw new Error('Baichuan request failed (responseCode 400, empty body)')
    })
    const getPirInfo = vi.fn(async () => ({ enabled: true, state: { enable: 1, sensitive: 50 } }))
    const h = build(
      async () => true,
      { setPirInfo, getPirInfo },
      { pirSensitive: 40, pirReduceAlarm: true, pirIntervalS: 30 },
    )
    await h.providers.switch!.setState({ deviceId: 41, on: true })
    expect(sent).toEqual([
      { enable: 1, sensitive: 61, reduceAlarm: 1, interval: 30 },
      { enable: 1, sensitive: 61 },
    ])
    expect(h.ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('reduced payload'),
      expect.objectContaining({ tags: { deviceId: 41 } }),
    )
  })

  it('raises a clear operator error when the reduced write fails too', async () => {
    const setPirInfo = vi.fn(async () => {
      throw new Error('Baichuan request failed (responseCode 400, empty body)')
    })
    const getPirInfo = vi.fn(async () => ({ enabled: true, state: { enable: 1 } }))
    const h = build(async () => true, { setPirInfo, getPirInfo })
    await expect(h.providers.switch!.setState({ deviceId: 41, on: true })).rejects.toThrow(
      /rejected the PIR settings/,
    )
    expect(setPirInfo).toHaveBeenCalledTimes(2)
  })
})
