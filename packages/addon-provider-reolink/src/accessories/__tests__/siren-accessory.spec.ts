/**
 * The timed `siren` cap on the Reolink siren accessory, against a fake camera:
 * trigger → camera gets plays, slice says active until now + real duration;
 * the countdown clears it; stop clears it; the plain switch keeps the slice honest.
 */
import {
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
  type SirenOptions,
  type SirenStatus,
  type SwitchStatus,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SirenAccessory } from '../siren.js'

const NOW = 1_700_000_000_000

interface Providers {
  siren?: {
    getOptions(input: { deviceId: number }): Promise<SirenOptions>
    getPlayChoices(input: { deviceId: number }): Promise<number[]>
    trigger(input: {
      deviceId: number
      durationSeconds?: number
      plays?: number
    }): Promise<SirenStatus>
    stop(input: { deviceId: number }): Promise<SirenStatus>
  }
  switch?: { setState(input: { deviceId: number; on: boolean }): Promise<void> }
}

function build(persisted: Record<string, unknown>) {
  let runtime: IDeviceRuntimeState | null = null
  const providers: Providers = {}
  const setSiren = vi.fn(async () => {})
  const ctx = {
    id: 31,
    stableId: 'reolink-siren',
    parentDeviceId: 30,
    deviceMeta: {
      type: DeviceType.Siren,
      name: 'Siren',
      location: null,
      disabled: false,
      addonId: 'provider-reolink',
      metadata: {},
    },
    persistedConfig: { kind: 'siren', channel: 2, ...persisted },
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
  const parent = { name: 'cam', ensureApi: async () => ({ setSiren }) }
  const device = new SirenAccessory(ctx, parent)
  const slice = <T extends Record<string, unknown>>(cap: string): Readonly<T> | undefined =>
    runtime?.getCapState<T>(cap)
  return { device, providers, setSiren, slice }
}

describe('Reolink siren accessory — timed siren cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('offers plays converted to seconds, marked as a fallback (the camera reports no counts)', async () => {
    const h = build({ sirenSecondsPerPlay: 4, sirenDurationS: 3 })
    const options = await h.providers.siren!.getOptions({ deviceId: 31 })
    expect(options).toMatchObject({ unit: 'plays', secondsPerPlay: 4, source: 'fallback' })
    expect(options.defaultSeconds).toBe(12)
  })

  it('trigger sends whole plays to the camera and publishes activeUntil = now + plays x seconds', async () => {
    const h = build({ sirenSecondsPerPlay: 4 })
    const status = await h.providers.siren!.trigger({ deviceId: 31, durationSeconds: 11 })
    expect(h.setSiren).toHaveBeenCalledWith(2, true, 3)
    expect(status).toMatchObject({ active: true, activeUntil: NOW + 12_000, durationSeconds: 12 })
    expect(h.slice<SirenStatus>('siren')).toMatchObject({ active: true, activeUntil: NOW + 12_000 })
    expect(h.slice<SwitchStatus>('switch')?.on).toBe(true)
  })

  it('declares its plays natively and offers them to a rule (#589)', async () => {
    const h = build({ sirenSecondsPerPlay: 4, sirenDurationS: 3 })
    expect(await h.providers.siren!.getOptions({ deviceId: 31 })).toMatchObject({
      allowedPlays: null,
      rangePlays: { min: 1, max: 60, step: 1 },
      defaultPlays: 3,
    })
    const choices = await h.providers.siren!.getPlayChoices({ deviceId: 31 })
    expect(choices[0]).toBe(1)
    expect(choices).toHaveLength(60)
  })

  it('a trigger in plays sends that count and reports it, with an estimated end', async () => {
    const h = build({ sirenSecondsPerPlay: 4 })
    const status = await h.providers.siren!.trigger({ deviceId: 31, plays: 4 })
    expect(h.setSiren).toHaveBeenCalledWith(2, true, 4)
    expect(status).toMatchObject({
      active: true,
      plays: 4,
      durationSeconds: 16,
      activeUntil: NOW + 16_000,
      activeUntilEstimated: true,
    })
  })

  it('a trigger in seconds reports no count; its end is still an estimate', async () => {
    const h = build({ sirenSecondsPerPlay: 4 })
    const status = await h.providers.siren!.trigger({ deviceId: 31, durationSeconds: 8 })
    expect(status).toMatchObject({ plays: null, activeUntilEstimated: true })
  })

  it('the countdown clears the siren slice and the switch when the plays are over', async () => {
    const h = build({ sirenSecondsPerPlay: 4 })
    await h.providers.siren!.trigger({ deviceId: 31, durationSeconds: 12 })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(h.slice<SirenStatus>('siren')).toMatchObject({ active: false, activeUntil: null })
    expect(h.slice<SwitchStatus>('switch')?.on).toBe(false)
  })

  it('stop silences the camera and clears the slice before the countdown ends', async () => {
    const h = build({ sirenSecondsPerPlay: 4 })
    await h.providers.siren!.trigger({ deviceId: 31, durationSeconds: 12 })
    await h.providers.siren!.stop({ deviceId: 31 })
    expect(h.setSiren).toHaveBeenLastCalledWith(2, false, undefined)
    expect(h.slice<SirenStatus>('siren')).toMatchObject({ active: false, activeUntil: null })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.slice<SirenStatus>('siren')?.active).toBe(false)
  })

  it('the plain switch publishes the siren slice: counted plays are timed, manual is open-ended', async () => {
    const counted = build({ sirenSecondsPerPlay: 2, sirenDurationS: 5 })
    await counted.providers.switch!.setState({ deviceId: 31, on: true })
    expect(counted.slice<SirenStatus>('siren')).toMatchObject({
      active: true,
      activeUntil: NOW + 10_000,
    })

    const manual = build({ sirenDurationS: 0 })
    await manual.providers.switch!.setState({ deviceId: 31, on: true })
    expect(manual.slice<SirenStatus>('siren')).toMatchObject({ active: true, activeUntil: null })
    await manual.providers.switch!.setState({ deviceId: 31, on: false })
    expect(manual.slice<SirenStatus>('siren')?.active).toBe(false)
  })
})
