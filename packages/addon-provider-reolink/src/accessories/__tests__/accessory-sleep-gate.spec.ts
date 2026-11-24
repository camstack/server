/**
 * #666 — 2026-11-24 04:21:58, device 640: the parent's `onProbe` skipped
 * ("battery cam is sleeping"), and 0.4 s later the camera woke anyway:
 * `SirenAccessory.onProbe -> refreshMotionTriggerFromFirmware -> ensureApi`.
 * An accessory probe, or a cap read that revalidates, must never log in to a
 * sleeping battery camera: it serves its persisted state and the parent's wake
 * transition (`alignAuxDevicesState('wake')`) refreshes it.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ReolinkAccessoryHost } from '../base.js'
import { FloodlightAccessory } from '../floodlight.js'
import { PirAccessory } from '../pir.js'
import { SirenAccessory } from '../siren.js'

interface StatusProvider {
  getStatus?: (input: { deviceId: number }) => Promise<unknown>
}

interface Probeable {
  onProbe(): Promise<void>
}

type Factory = (ctx: DeviceContext, parent: ReolinkAccessoryHost) => Probeable

interface Harness {
  readonly ensureApi: ReturnType<typeof vi.fn>
  readonly wakeUp: ReturnType<typeof vi.fn>
  readonly logger: { info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
  readonly providers: Record<string, StatusProvider>
  readonly probe: () => Promise<void>
}

function build(
  kind: string,
  create: Factory,
  host: { battery: boolean; sleeping: boolean },
): Harness {
  let runtime: IDeviceRuntimeState | null = null
  const providers: Record<string, StatusProvider> = {}
  const wakeUp = vi.fn(async () => {})
  const ensureApi = vi.fn(async () => ({
    wakeUp,
    getSirenOnMotion: async () => ({}),
    getFloodlightOnMotion: async () => ({}),
    getWhiteLedState: async () => ({}),
    getCachedFloodlightStatus: () => undefined,
    getPirInfo: async () => ({ enabled: false }),
  }))
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = {
    id: 31,
    stableId: `reolink-${kind}`,
    parentDeviceId: 30,
    deviceMeta: {
      type: DeviceType.Siren,
      name: kind,
      location: null,
      disabled: false,
      addonId: 'provider-reolink',
      metadata: {},
    },
    persistedConfig: { kind: kind === 'pir' ? 'pir-sensor' : kind, channel: 0 },
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
    logger,
  } as unknown as DeviceContext
  const parent: ReolinkAccessoryHost = {
    name: 'cam',
    ensureApi,
    isBatteryCam: () => host.battery,
    isSleeping: () => host.sleeping,
    wakeForWrite: async () => true,
  }
  const device = create(ctx, parent)
  return { ensureApi, wakeUp, logger, providers, probe: () => device.onProbe() }
}

const KINDS: ReadonlyArray<readonly [string, Factory]> = [
  ['siren', (c, p) => new SirenAccessory(c, p)],
  ['floodlight', (c, p) => new FloodlightAccessory(c, p)],
  ['pir', (c, p) => new PirAccessory(c, p)],
]

describe.each(KINDS)('%s accessory on a sleeping battery camera', (kind, create) => {
  it('onProbe with no cached state does not log in, wake or call the camera', async () => {
    const h = build(kind, create, { battery: true, sleeping: true })
    await h.probe()
    expect(h.ensureApi).not.toHaveBeenCalled()
    expect(h.wakeUp).not.toHaveBeenCalled()
  })

  it('logs the skip under the device tag', async () => {
    const h = build(kind, create, { battery: true, sleeping: true })
    await h.probe()
    const lines = [...h.logger.info.mock.calls, ...h.logger.debug.mock.calls]
    const skip = lines.find(([msg]) => String(msg).includes('skipped'))
    expect(skip?.[1]).toMatchObject({ tags: { deviceId: 31 } })
  })

  it('control: an awake camera is probed', async () => {
    const h = build(kind, create, { battery: true, sleeping: false })
    await h.probe()
    expect(h.ensureApi).toHaveBeenCalled()
  })
})

describe.each(
  KINDS.filter(([k]) => k !== 'pir'),
)('%s motion-trigger read on a sleeping battery camera', (kind, create) => {
  it('a stale read serves the persisted slice and does not log in', async () => {
    const h = build(kind, create, { battery: true, sleeping: true })
    await h.providers['motion-trigger']?.getStatus?.({ deviceId: 31 })
    expect(h.ensureApi).not.toHaveBeenCalled()
  })
})
