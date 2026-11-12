import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HaContainerDevice } from '../devices/ha-container-device.js'
import { parseContainerEntities } from '../ha-container-reconcile.js'

/**
 * D1033 retired `DeviceType.Thermostat`. A Container adopted before that still
 * persists `entities[].deviceType: 'thermostat'`; restoring it must never drop
 * the Container and every child — the stored type is read as its live type.
 */
const STORED_ENTITIES = [
  {
    entityId: 'climate.living_room',
    deviceType: 'thermostat',
    capabilities: ['climate-control'],
    name: 'Living room',
  },
  {
    entityId: 'sensor.living_room_temperature',
    deviceType: DeviceType.Sensor,
    capabilities: ['numeric-sensor'],
  },
]

function makeCtx(config: Record<string, unknown>): import('@camstack/types').DeviceContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  let runtimeState: IDeviceRuntimeState | null = null
  return {
    id: 300,
    stableId: 'ha:test:300',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Container,
      name: 'Thermostat',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeState = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeState) {
        runtimeState.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    api: {},
    logger,
  } as unknown as import('@camstack/types').DeviceContext
}

describe('HA Container with a retired stored device type (D1033)', () => {
  it('restores, and the thermostat child gets the canonical climate type', () => {
    const device = new HaContainerDevice(
      makeCtx({
        system: 'homeassistant',
        haDeviceId: 'dev-thermostat',
        brokerId: 'ha_001',
        integrationId: 'int-1',
        entities: STORED_ENTITIES,
      }),
    )
    const children = device.getAccessoryChildren()
    expect(children.map((c) => c.meta.type)).toEqual([DeviceType.Climate, DeviceType.Sensor])
  })

  it('the reconcile parser keeps the entities instead of discarding the blob', () => {
    const parsed = parseContainerEntities(STORED_ENTITIES)
    expect(parsed.map((e) => e.deviceType)).toEqual([DeviceType.Climate, DeviceType.Sensor])
  })
})
