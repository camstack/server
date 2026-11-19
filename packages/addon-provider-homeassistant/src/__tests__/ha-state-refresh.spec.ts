import { describe, expect, it, vi } from 'vitest'
import {
  DeviceType,
  deviceStateRefreshCapability,
  type DeviceContext,
  type IDeviceRuntimeState,
  type CoverStatus,
} from '@camstack/types'
import { HaCoverDevice } from '../devices/ha-cover-device.js'

interface Registration {
  readonly cap: { readonly name: string }
  readonly provider: { refresh: () => Promise<{ ok: boolean }> }
  readonly options: { readonly stateRefresh?: Record<string, unknown> } | undefined
}

function makeCover(cached: unknown) {
  const registrations: Registration[] = []
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const getState = vi.fn(async () => cached)
  const ctx = {
    id: 7,
    stableId: 'ha:test:7',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Cover,
      name: 'Test Cover',
      location: null,
      disabled: false,
      addonId: 'ha',
      metadata: {},
    },
    persistedConfig: {
      brokerId: 'ha_001',
      entityId: 'cover.lr',
      capabilities: ['cover'],
    },
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({
      deviceState: { setCapSlice: vi.fn(async () => {}) },
    })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 1),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn(
      (
        cap: { name: string; runtimeState?: unknown },
        provider: Registration['provider'],
        options?: Registration['options'],
      ) => {
        registrations.push({ cap, provider, options })
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      },
    ),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 's' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
        getState: { query: getState },
      },
      deviceManager: {
        registerDevice: { mutate: vi.fn(async () => ({})) },
        setMetadata: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
  const device = new HaCoverDevice(ctx)
  return {
    device,
    registrations,
    getState,
    coverSlice: () => device.runtimeState.getCapState<CoverStatus>('cover'),
  }
}

const OPEN = {
  entity_id: 'cover.lr',
  state: 'open',
  attributes: { current_position: 100 },
  last_changed: '2026-11-19T10:00:00Z',
  last_updated: '2026-11-19T10:00:00Z',
}

describe('HA entity device-state-refresh (D1062)', () => {
  it('declares push full for the broker, so the core never schedules a read', async () => {
    const { device, registrations } = makeCover(OPEN)
    await device.onActivate()
    const reg = registrations.find((r) => r.cap.name === deviceStateRefreshCapability.name)
    expect(reg?.options?.stateRefresh).toMatchObject({
      integrationId: 'ha_001',
      push: 'full',
      batch: false,
    })
  })

  it('a refresh re-applies the broker cached state to the device', async () => {
    const { device, registrations, getState, coverSlice } = makeCover(OPEN)
    await device.onActivate()
    expect(coverSlice()?.state).toBe('closed')
    const reg = registrations.find((r) => r.cap.name === deviceStateRefreshCapability.name)
    await reg?.provider.refresh()
    expect(getState).toHaveBeenCalledWith({
      brokerId: 'ha_001',
      key: 'cover.lr',
    })
    expect(coverSlice()?.state).toBe('open')
  })

  it('a refresh of an entity the broker does not know fails, never a silent success', async () => {
    const { device, registrations } = makeCover(null)
    await device.onActivate()
    const reg = registrations.find((r) => r.cap.name === deviceStateRefreshCapability.name)
    await expect(reg?.provider.refresh()).rejects.toThrow(/no cached state for cover\.lr/)
  })
})
