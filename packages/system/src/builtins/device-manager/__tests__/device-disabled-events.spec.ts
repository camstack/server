/**
 * `setDisabled` announces the SWITCH, and only when it moves.
 *
 * `device.disabled` / `device.enabled` existed in the category enum and were
 * emitted by nobody — the stream-broker has subscribed to `device.disabled`
 * since it was written, waiting for an event that never came. This pins the
 * emission and, more importantly, its TRANSITION rule: the operator asked to
 * be told when a camera is switched off, not every time something writes the
 * flag it already had.
 *
 * `device.meta-changed` is deliberately left alone (still fired on every call):
 * it is the meta-surface echo the UI redraws on, not a lifecycle announcement.
 *
 * Harness style mirrors `display-meta.spec.ts` — in-memory settings, real
 * `DeviceRegistry`, fake device.
 */

import type {
  AddonContext,
  IDevice,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SystemEvent,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
// Source imports (not the `@camstack/system` barrel) so the suite runs without
// a built dist — the barrel transitively pulls node-only deps.
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

let fakeIdSeq = 900

class FakeDevice {
  online = true
  parentDeviceId: number | null = null
  features: readonly string[] = []
  type = 'camera'
  name: string
  readonly id: number
  readonly config = {
    entries: () => [],
    get: () => undefined,
    set: vi.fn(async () => {}),
    setAll: vi.fn(async () => {}),
    onChange: () => () => {},
  }
  constructor(
    readonly stableId: string,
    id?: number,
  ) {
    this.id = id ?? fakeIdSeq++
    this.name = stableId
  }
  removeDevice = vi.fn(async () => {})
}

/** Fake → interface: the one documented type boundary this harness needs. */
function asDevice(d: FakeDevice): IDevice {
  return d as unknown as IDevice
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeSettings() {
  const addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  const runtimeStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores[id] })),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
    clearDeviceStore: vi.fn(async (id: number) => {
      delete deviceStores[id]
    }),
    readDeviceRuntimeState: vi.fn(async (id: number) => ({ ...runtimeStores[id] })),
    writeDeviceRuntimeState: vi.fn(async (id: number, data: Record<string, unknown>) => {
      runtimeStores[id] = { ...data }
    }),
    clearDeviceRuntimeState: vi.fn(async (id: number) => {
      delete runtimeStores[id]
    }),
  }
}

async function setup(): Promise<{
  provider: IDeviceManagerProvider
  events: SystemEvent[]
  registry: DeviceRegistry
}> {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const events: SystemEvent[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      events.push(event)
    },
    subscribe: () => () => {},
    getRecent: () => [],
    // Fake → interface: the bus has typed `emit`/`subscribe` overloads a plain
    // object literal cannot state. Same boundary the sibling specs use.
  } as unknown as IEventBus
  const registry = new DeviceRegistry()
  const { api: settingsStoreApi } = await makeSettingsStoreApi()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: bus,
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    records,
    kernel: { deviceRegistry: registry },
  }
  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  let providers: readonly ProviderRegistration[] | undefined
  if (Array.isArray(initResult)) providers = initResult
  else if (initResult) providers = initResult.providers
  const first = providers?.[0]
  if (!first) throw new Error('no provider registrations')
  const provider = first.provider
  if (!('setDisabled' in provider)) throw new Error('not the device-manager provider')
  return { provider: provider as IDeviceManagerProvider, events, registry }
}

async function registerCamera(
  provider: IDeviceManagerProvider,
  registry: DeviceRegistry,
  stableId: string,
): Promise<number> {
  const dev = new FakeDevice(stableId)
  registry.register('rtsp', asDevice(dev))
  await provider.allocateDeviceId({ addonId: 'rtsp', stableId })
  await provider.registerDevice({
    addonId: 'rtsp',
    stableId,
    id: dev.id,
    type: 'camera',
    name: stableId,
    parentDeviceId: null,
    config: {},
  })
  return dev.id
}

function categories(events: readonly SystemEvent[]): string[] {
  return events.map((e) => e.category)
}

describe('setDisabled announces the switch', () => {
  it('emits device.disabled on the off transition, with the device id', async () => {
    const { provider, events, registry } = await setup()
    const deviceId = await registerCamera(provider, registry, 'cam-a')

    events.length = 0
    await provider.setDisabled({ deviceId, disabled: true })

    expect(categories(events)).toContain(EventCategory.DeviceDisabled)
    const disabled = events.find((e) => e.category === EventCategory.DeviceDisabled)
    expect(disabled?.data).toMatchObject({ deviceId })
    expect(disabled?.source).toMatchObject({ type: 'device', id: deviceId })
    // The meta echo still fires — it is a different message for a different
    // consumer (the UI redraw), not the lifecycle announcement.
    expect(categories(events)).toContain(EventCategory.DeviceMetaChanged)
  })

  it('emits device.enabled on the way back on', async () => {
    const { provider, events, registry } = await setup()
    const deviceId = await registerCamera(provider, registry, 'cam-b')
    await provider.setDisabled({ deviceId, disabled: true })

    events.length = 0
    await provider.setDisabled({ deviceId, disabled: false })

    expect(categories(events)).toContain(EventCategory.DeviceEnabled)
    expect(categories(events)).not.toContain(EventCategory.DeviceDisabled)
  })

  it('says NOTHING when the flag does not move', async () => {
    const { provider, events, registry } = await setup()
    const deviceId = await registerCamera(provider, registry, 'cam-c')
    await provider.setDisabled({ deviceId, disabled: true })

    events.length = 0
    await provider.setDisabled({ deviceId, disabled: true })

    expect(categories(events)).not.toContain(EventCategory.DeviceDisabled)
    expect(categories(events)).not.toContain(EventCategory.DeviceEnabled)
  })

  it('treats a never-disabled device as enabled — re-enabling it announces nothing', async () => {
    const { provider, events, registry } = await setup()
    const deviceId = await registerCamera(provider, registry, 'cam-d')

    events.length = 0
    await provider.setDisabled({ deviceId, disabled: false })

    expect(categories(events)).not.toContain(EventCategory.DeviceEnabled)
    expect(categories(events)).not.toContain(EventCategory.DeviceDisabled)
  })
})
