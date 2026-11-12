/**
 * D1022 - the hub announces each settled vocabulary command on the event bus:
 * the device-manager maps the correlator's `DeviceCommandSettledEvent` onto a
 * `device.command-settled` SystemEvent sourced at the device. Telemetry (D8),
 * so the only thing pinned is the mapping the Notification Center reads.
 */
import type {
  AddonContext,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SystemEvent,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCommandObserverRegistryForTests,
  getCommandObserverRegistry,
} from '../../../kernel/command-observation.js'
import { DeviceRegistry } from '../../../kernel/device-registry.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi } from './settings-store-api.js'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'

afterEach(() => __resetCommandObserverRegistryForTests())

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

async function setup(): Promise<{ events: SystemEvent[]; addon: DeviceManagerAddon }> {
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
  if (providers === undefined) throw new Error('no provider registrations')
  return { events, addon }
}

describe('a settled command reaches the event bus', () => {
  it('a failed vocabulary command is emitted as device.command-settled at its device, with no arguments', async () => {
    const { events, addon } = await setup()
    const failure = Promise.reject(new Error('device unreachable'))
    getCommandObserverRegistry().observe({
      deviceId: 7,
      capName: 'switch',
      method: 'setState',
      args: { deviceId: 7, on: true },
      actor: { kind: 'user', userId: 'u', username: 'ada', credential: 'session' },
      at: 1000,
      outcome: failure,
    })
    await failure.catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()

    const settled = events.filter((e) => e.category === EventCategory.DeviceCommandSettled)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.source).toEqual({ type: 'device', id: 7 })
    expect(settled[0]?.data).toEqual({
      deviceId: 7,
      action: 'switch.on',
      outcome: 'failed',
      actor: { kind: 'user', userId: 'u', username: 'ada', credential: 'session' },
      at: 1000,
    })
    await addon.shutdown()
  })
})
