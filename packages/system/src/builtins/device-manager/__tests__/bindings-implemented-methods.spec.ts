/**
 * #459 — a binding says which optional methods its provider really serves.
 * Hub-local: read off the registered provider object. Cross-process: carried by
 * the `DeviceBindingsChanged` event the worker emits at registration.
 */
import { CapabilityRegistry, DeviceRegistry } from '@camstack/server/system'
import {
  type AddonContext,
  coverCapability,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
  type SystemEvent,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { wireRemoteNativeCapSync, type RemoteNativeCaps } from '../device-bindings-store.js'
import { makeSettingsStoreApi, seedDeviceRow } from './settings-store-api.js'

const DEVICE = 4410

function logger(): IScopedLogger {
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

describe('bindings report the implemented methods', () => {
  it('a hub-local provider is read off the registered object', async () => {
    const addon = new DeviceManagerAddon()
    const store = await makeSettingsStoreApi()
    const ctx = {
      api: { settingsStore: store.api },
      id: 'device-manager',
      logger: logger(),
      eventBus: {
        emit: vi.fn(),
        subscribe: () => () => {},
        getRecent: () => [],
      } as unknown as IEventBus,
      addonConfig: {},
      dataDir: '/tmp',
      settings: {
        readAddonStore: async () => ({}),
        writeAddonStore: async () => {},
        readDeviceStore: async () => ({}),
        writeDeviceStore: async () => {},
      },
      records: await makeRecordsAccessForOwner('device-manager'),
      kernel: { deviceRegistry: new DeviceRegistry() } as Record<string, unknown>,
    }
    await addon.initialize(ctx as unknown as AddonContext)
    await seedDeviceRow(store, { deviceId: DEVICE, type: 'cover' })
    const registry = new CapabilityRegistry(logger())
    registry.declareCapability(coverCapability)
    registry.registerNativeProvider('cover', DEVICE, 'provider-x', {
      setPosition: async () => {},
      open: async () => {},
      close: async () => {},
    })
    registry.ready()
    ctx.kernel.capabilityRegistry = registry

    const { entries } = await addon.getBindings({ deviceId: DEVICE })
    const cover = entries.find((e) => e.capName === 'cover')
    expect(cover?.implementedMethods).toContain('setPosition')
    expect(cover?.implementedMethods).not.toContain('stop')
    expect(cover?.implementedMethods).not.toContain('setTiltPosition')
  })

  it('a remote registration carries the set its worker sent', () => {
    const remote: RemoteNativeCaps = new Map()
    const captured: { handler: ((event: SystemEvent) => void) | null } = { handler: null }
    const bus = {
      emit: vi.fn(),
      getRecent: () => [],
      subscribe: (_filter: unknown, h: (event: SystemEvent) => void) => {
        captured.handler = h
        return () => {}
      },
    } as unknown as IEventBus
    wireRemoteNativeCapSync(
      {
        eventBus: bus,
        logger: logger(),
        kernel: { localNodeId: 'hub' },
      } as unknown as AddonContext,
      remote,
    )
    captured.handler?.({
      id: 'e',
      timestamp: new Date(),
      source: { type: 'device', id: DEVICE },
      category: EventCategory.DeviceBindingsChanged,
      data: {
        deviceId: DEVICE,
        capName: 'cover',
        reason: 'native-registered',
        addonId: 'provider-x',
        nodeId: 'agent-a',
        implementedMethods: ['setPosition'],
      },
    })
    expect(remote.get(DEVICE)?.get('cover')?.implementedMethods).toEqual(['setPosition'])
  })
})
