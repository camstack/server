import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaContainerDevice } from '../devices/ha-container-device.js'

interface ContainerOnlineHarness {
  device: HaContainerDevice
  /** Dispatch a broker.message to EVERY subscribed handler (availability +
   *  battery), mirroring the in-process event bus fan-out. */
  push: (msg: { brokerId: string; key: string; payload: unknown }) => void
}

/**
 * Build a HaContainerDevice and capture ALL broker.message handlers (the
 * container attaches both an availability listener (A3) and, when a battery
 * entity is present, a battery listener — each via its own `subscribe` call).
 */
async function makeContainer(config: Record<string, unknown>): Promise<ContainerOnlineHarness> {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const handlers: ((event: { data: unknown }) => void)[] = []

  const ctx = {
    id: 200,
    stableId: 'ha:container:200',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Container,
      name: 'Clima studio',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
        handlers.push(handler)
        return () => {}
      }),
      getRecent: vi.fn(() => []),
    },
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-x' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
        getState: { query: vi.fn(async () => null) },
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

  const device = new HaContainerDevice(ctx)
  await device.onActivate()
  return {
    device,
    push: (msg) => {
      for (const h of handlers) h({ data: msg })
    },
  }
}

const TWO_ENTITY_CONFIG = {
  system: 'homeassistant',
  brokerId: 'ha_001',
  haDeviceId: 'ha-dev-clima',
  entities: [
    {
      entityId: 'climate.studio',
      deviceType: DeviceType.Thermostat,
      capabilities: ['climate-control'],
    },
    {
      entityId: 'sensor.studio_temp',
      deviceType: DeviceType.Sensor,
      capabilities: ['temperature-sensor'],
    },
  ],
}

describe('HaContainerDevice online derived from children (A3)', () => {
  it('starts offline before any push (not hardcoded true)', async () => {
    const { device } = await makeContainer(TWO_ENTITY_CONFIG)
    expect(device.online).toBe(false)
  })

  it('is online when at least one child entity is reachable', async () => {
    const { device, push } = await makeContainer(TWO_ENTITY_CONFIG)
    push({
      brokerId: 'ha_001',
      key: 'climate.studio',
      payload: { state: 'heat', last_updated: new Date().toISOString(), attributes: {} },
    })
    expect(device.online).toBe(true)
  })

  it('is offline when ALL child entities are unavailable', async () => {
    const { device, push } = await makeContainer(TWO_ENTITY_CONFIG)
    // Both children reachable first.
    push({
      brokerId: 'ha_001',
      key: 'climate.studio',
      payload: { state: 'heat', last_updated: new Date().toISOString(), attributes: {} },
    })
    push({
      brokerId: 'ha_001',
      key: 'sensor.studio_temp',
      payload: { state: '21.5', last_updated: new Date().toISOString(), attributes: {} },
    })
    expect(device.online).toBe(true)

    // Now both go unavailable → container offline.
    push({
      brokerId: 'ha_001',
      key: 'climate.studio',
      payload: { state: 'unavailable', last_updated: new Date().toISOString(), attributes: {} },
    })
    push({
      brokerId: 'ha_001',
      key: 'sensor.studio_temp',
      payload: { state: 'unavailable', last_updated: new Date().toISOString(), attributes: {} },
    })
    expect(device.online).toBe(false)
  })

  it('stays online while only SOME children are unavailable', async () => {
    const { device, push } = await makeContainer(TWO_ENTITY_CONFIG)
    push({
      brokerId: 'ha_001',
      key: 'climate.studio',
      payload: { state: 'unavailable', last_updated: new Date().toISOString(), attributes: {} },
    })
    push({
      brokerId: 'ha_001',
      key: 'sensor.studio_temp',
      payload: { state: '21.5', last_updated: new Date().toISOString(), attributes: {} },
    })
    expect(device.online).toBe(true)
  })
})
