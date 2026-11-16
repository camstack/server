/**
 * The timed `siren` and `motion-trigger` caps on the Hikvision siren accessory,
 * against a fake ISAPI client.
 */
import {
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
  type MotionTriggerRuntimeState,
  type SirenOptions,
  type SirenStatus,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HikvisionSirenAccessory } from '../siren.js'

const NOW = 1_700_000_000_000

interface Providers {
  siren?: {
    getOptions(input: { deviceId: number }): Promise<SirenOptions>
    trigger(input: { deviceId: number; durationSeconds?: number }): Promise<SirenStatus>
    stop(input: { deviceId: number }): Promise<SirenStatus>
  }
  'motion-trigger'?: {
    getStatus(input: { deviceId: number }): Promise<{ enabled: boolean }>
    setMotionTrigger(input: { deviceId: number; enabled: boolean }): Promise<void>
  }
}

function build(opts: { beep?: boolean; inputIds?: string[] } = {}) {
  let runtime: IDeviceRuntimeState | null = null
  const providers: Providers = {}
  const client = {
    setAlarmInput: vi.fn(async () => {}),
    getAlarmInputs: vi.fn(async () =>
      (opts.inputIds ?? ['1']).map((id) => ({ id, name: null, enabled: true })),
    ),
    getMotionTriggerLinkage: vi.fn(async () => ({
      beep: opts.beep ?? false,
      whiteLight: false,
      ioOutput: false,
      center: false,
    })),
    setMotionTriggerLinkage: vi.fn(async () => {}),
  }
  const ctx = {
    id: 41,
    stableId: 'hik-siren',
    parentDeviceId: 40,
    deviceMeta: {
      type: DeviceType.Siren,
      name: 'Siren',
      location: null,
      disabled: false,
      addonId: 'provider-hikvision',
      metadata: {},
    },
    persistedConfig: { kind: 'siren', cameraNumber: 1, port: 1, pulseDurationMs: 8_000 },
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
  const parent = { name: 'cam', ensureClient: () => client, alarmInputPorts: () => [1] }
  // The accessory's parent host is the camera; the spec supplies the slice of it the siren reads.
  const device = new HikvisionSirenAccessory(ctx, parent as never)
  const slice = <T>(cap: string): T | undefined => runtime?.getCapState<T>(cap)
  return { device, providers, client, slice }
}

describe('Hikvision siren accessory — timed siren cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('getOptions says camera when the probe lists the port, fallback when it does not', async () => {
    const confirmed = build({ inputIds: ['1'] })
    expect(await confirmed.providers.siren!.getOptions({ deviceId: 41 })).toMatchObject({
      unit: 'seconds',
      source: 'camera',
      defaultSeconds: 8,
    })
    const absent = build({ inputIds: ['3'] })
    expect((await absent.providers.siren!.getOptions({ deviceId: 41 })).source).toBe('fallback')
  })

  it('trigger holds the input and publishes activeUntil = now + the real duration, then releases', async () => {
    const h = build()
    const status = await h.providers.siren!.trigger({ deviceId: 41, durationSeconds: 20 })
    expect(h.client.setAlarmInput).toHaveBeenCalledWith(true, 1)
    expect(status).toMatchObject({ active: true, activeUntil: NOW + 20_000, durationSeconds: 20 })
    expect(h.slice<SirenStatus>('siren')).toMatchObject({ active: true, activeUntil: NOW + 20_000 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.client.setAlarmInput).toHaveBeenLastCalledWith(false, 1)
    expect(h.slice<SirenStatus>('siren')).toMatchObject({ active: false, activeUntil: null })
  })

  it('stop releases the input and clears the slice', async () => {
    const h = build()
    await h.providers.siren!.trigger({ deviceId: 41, durationSeconds: 20 })
    await h.providers.siren!.stop({ deviceId: 41 })
    expect(h.client.setAlarmInput).toHaveBeenLastCalledWith(false, 1)
    expect(h.slice<SirenStatus>('siren')?.active).toBe(false)
  })
})

describe('Hikvision siren accessory — motion-trigger cap (VMD beep linkage)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('setMotionTrigger toggles the beep linkage of the camera number and records the slice', async () => {
    const h = build()
    await h.providers['motion-trigger']!.setMotionTrigger({ deviceId: 41, enabled: true })
    expect(h.client.setMotionTriggerLinkage).toHaveBeenCalledWith(1, { beep: true })
    expect(h.slice<MotionTriggerRuntimeState>('motion-trigger')).toMatchObject({
      enabled: true,
      lastFetchedAt: NOW,
    })
  })

  it('a stale slice is refreshed from the camera linkage', async () => {
    const h = build({ beep: true })
    expect(await h.providers['motion-trigger']!.getStatus({ deviceId: 41 })).toMatchObject({
      enabled: true,
    })
    expect(h.client.getMotionTriggerLinkage).toHaveBeenCalledWith(1)
  })
})
