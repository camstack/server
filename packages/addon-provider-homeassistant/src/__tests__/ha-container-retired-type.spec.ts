import {
  type CapabilityDefinition,
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
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

const DEVICE_ID = 300
const STABLE_ID = 'ha:test:300'

/** A typed device context: the addon-context fake supplies the logger, bus, api and devices. */
function makeCtx(config: Record<string, unknown>): DeviceContext {
  const base = fakeAddonContext({ id: 'provider-homeassistant' })
  let runtimeState: IDeviceRuntimeState | null = null
  return {
    id: DEVICE_ID,
    stableId: STABLE_ID,
    parentDeviceId: null,
    logger: base.logger,
    api: base.api,
    eventBus: base.eventBus,
    devices: base.kernel.devices,
    deviceMeta: {
      id: DEVICE_ID,
      stableId: STABLE_ID,
      addonId: 'provider-homeassistant',
      type: DeviceType.Container,
      name: 'Thermostat',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: config,
    initialRuntimeState: {},
    persistConfig: async () => {},
    fetchDevice: () => Promise.reject(new Error('fetchDevice is not part of this test')),
    bindRuntimeState: (rs) => {
      runtimeState = rs
    },
    registerNativeCap(cap: CapabilityDefinition): void {
      if (cap.runtimeState !== undefined && runtimeState !== null) {
        runtimeState.installCapSchema(cap.name, cap.runtimeState)
      }
    },
  }
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
