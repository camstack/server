/**
 * A composed cap (a composer `add` graft) is bound from boot by its persisted claim,
 * so an exporter sees one stable device shape across a hub or composer restart.
 */
import { DeviceRegistry } from '@camstack/server/system'
import {
  type AddonContext,
  EventCategory,
  type EventFilter,
  type IEventBus,
  type IScopedLogger,
  type SystemEvent,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi } from './settings-store-api.js'
import { COMPOSER_ADDON_ID } from '@camstack/types'
import type { AddonStoreRead } from '@camstack/types'
import { seedDeviceRow } from './settings-store-api.js'

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

interface HandlerEntry {
  readonly pattern: string
  readonly handler: (event: SystemEvent) => void
}

function makeEventBus(handlers: HandlerEntry[]): IEventBus {
  return {
    emit: vi.fn((event: SystemEvent) => {
      for (const { pattern, handler } of handlers) {
        if (event.category === pattern) handler(event)
      }
    }),
    subscribe: vi.fn((filter: EventFilter | string, handler: (event: SystemEvent) => void) => {
      const pattern =
        typeof filter === 'string'
          ? filter
          : typeof filter.category === 'string'
            ? filter.category
            : String(filter.category ?? '*')
      const entry: HandlerEntry = { pattern, handler }
      handlers.push(entry)
      return () => {
        const idx = handlers.indexOf(entry)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    }),
    getRecent: vi.fn(() => []),
  } as unknown as IEventBus
}

function makeSettings() {
  const addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores[id] })),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
  }
}

function emitRemoteBindingEvent(
  bus: IEventBus,
  payload: {
    deviceId: number
    capName: string
    reason: 'native-registered' | 'native-unregistered'
    addonId: string
    nodeId: string
  },
): void {
  bus.emit({
    id: 'evt-' + Math.random().toString(36).slice(2),
    timestamp: new Date(),
    source: { type: 'device', id: payload.deviceId },
    category: EventCategory.DeviceBindingsChanged,
    data: payload,
  })
}

const CAM = 615
const COMPOSER_ADD = {
  deviceId: CAM,
  capName: 'doorbell',
  owner: 'blk-doorbell',
  mode: 'add',
  fields: ['pressed'],
} as const

/** Settings whose addon store persists a claims index, as the hub's does across a restart. */
function settingsWithClaims(claims: readonly unknown[]) {
  const base = makeSettings()
  return {
    ...base,
    readAddonStoreResult: vi.fn(
      async (): Promise<AddonStoreRead> => ({
        kind: 'value',
        value: { 'field-claims-index': claims },
      }),
    ),
  }
}

async function bootAddon(
  claims: readonly unknown[],
  handlers: HandlerEntry[],
): Promise<DeviceManagerAddon> {
  const addon = new DeviceManagerAddon()
  const store = await makeSettingsStoreApi()
  await seedDeviceRow(store, { deviceId: CAM, type: 'camera' })
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: store.api },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: makeEventBus(handlers),
    addonConfig: {},
    dataDir: '/tmp',
    settings: settingsWithClaims(claims),
    records,
    kernel: { deviceRegistry: new DeviceRegistry(), localNodeId: 'hub' },
  }
  await addon.initialize(ctx as unknown as AddonContext)
  return addon
}

async function capsOf(addon: DeviceManagerAddon): Promise<string[]> {
  const { entries } = await addon.getBindings({ deviceId: CAM })
  return entries.map((e) => e.capName).filter((c) => c === 'doorbell')
}

describe('a composed `add` claim binds its cap from boot', () => {
  it('a persisted add claim is a binding before the graft lands, provider = composer', async () => {
    const addon = await bootAddon([COMPOSER_ADD], [])
    const { entries } = await addon.getBindings({ deviceId: CAM })
    const entry = entries.find((e) => e.capName === 'doorbell')
    expect(entry?.providerAddonId).toBe(COMPOSER_ADDON_ID)
    expect(entry?.kind).toBe('native')
  })

  it('no claim, no binding', async () => {
    const addon = await bootAddon([], [])
    expect(await capsOf(addon)).toEqual([])
  })

  it('a replace claim does not bind a cap (only an add claim is a graft)', async () => {
    const addon = await bootAddon([{ ...COMPOSER_ADD, mode: 'replace' }], [])
    expect(await capsOf(addon)).toEqual([])
  })

  it('the cap stays bound, once, through a composer restart (graft unregistered, then registered)', async () => {
    const handlers: HandlerEntry[] = []
    const addon = await bootAddon([COMPOSER_ADD], handlers)
    const bus = makeEventBus(handlers)
    const graft = (reason: 'native-registered' | 'native-unregistered'): void =>
      emitRemoteBindingEvent(bus, {
        deviceId: CAM,
        capName: 'doorbell',
        reason,
        addonId: COMPOSER_ADDON_ID,
        nodeId: 'hub-composer-runner',
      })

    const seen = [await capsOf(addon)]
    graft('native-registered')
    seen.push(await capsOf(addon))
    graft('native-unregistered')
    seen.push(await capsOf(addon))
    graft('native-registered')
    seen.push(await capsOf(addon))

    expect(seen).toEqual([['doorbell'], ['doorbell'], ['doorbell'], ['doorbell']])
  })
})
