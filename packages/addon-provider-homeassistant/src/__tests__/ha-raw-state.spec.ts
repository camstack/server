import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaControlDevice } from '../devices/ha-control-device.js'
import type { HaEntityState } from '../ha-types.js'

/**
 * Build a HaControlDevice over a DeviceContext stub whose `broker.getState`
 * query returns the supplied cached entity state (or null). Returns the
 * device instance so callers can invoke `getRawState()` and assert.
 */
function makeChildWithCachedState(cached: HaEntityState | null): HaControlDevice {
  let runtimeStateRef: IDeviceRuntimeState | null = null

  const getStateQuery = vi.fn(async () => cached)

  const ctx = {
    id: 21,
    stableId: 'ha:test:21',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Control,
      name: 'Raw State Device',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: {
      brokerId: 'ha_001',
      entityId: 'lock.front_door',
      capabilities: ['control'],
      role: 'select-control',
    },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
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
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-raw-1' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
        getState: { query: getStateQuery },
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
  } as unknown as import('@camstack/types').DeviceContext

  return new HaControlDevice(ctx)
}

describe('HA child getRawState', () => {
  it('returns {source:"homeassistant", data:{state, attributes}} from the cached entity state', async () => {
    const child = makeChildWithCachedState({
      entity_id: 'lock.front_door',
      state: 'unlocked',
      attributes: { supported_features: 1, device_class: 'door' },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    })

    const raw = await child.getRawState()
    expect(raw).toEqual({
      source: 'homeassistant',
      data: { state: 'unlocked', attributes: { supported_features: 1, device_class: 'door' } },
    })
  })

  it('returns null when the entity has no cached state', async () => {
    const child = makeChildWithCachedState(null)
    expect(await child.getRawState()).toBeNull()
  })
})
