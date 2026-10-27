/**
 * The switch child of a metered plug carries the readings of its sibling meter
 * sensors as its own `power-meter` (D951): it registers the cap, subscribes to
 * the sensors and writes each push into the matching field.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DeviceType,
  type DeviceContext,
  type IDeviceRuntimeState,
  type PowerMeterStatus,
} from '@camstack/types'
import { HaSwitchDevice } from '../devices/ha-switch-device.js'

type BusHandler = (event: { data: unknown }) => void

function build(config: Record<string, unknown>) {
  const names: string[] = []
  const handlers: BusHandler[] = []
  let runtimeState: IDeviceRuntimeState | null = null
  const subscribe = vi.fn(async () => ({ subscriptionId: 'sub-1' }))
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  const ctx = {
    id: 7,
    stableId: 'ha:test:7',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Switch,
      name: 'Desk plug',
      location: null,
      disabled: false,
      addonId: 'ha',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn((_filter: unknown, handler: BusHandler) => {
        handlers.push(handler)
        return () => {}
      }),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: { getChildren: vi.fn(async () => []) },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeState = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      names.push(cap.name)
      if (cap.runtimeState && runtimeState) {
        runtimeState.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn() },
        subscribe: { mutate: subscribe },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
      deviceManager: {
        registerDevice: { mutate: vi.fn(async () => ({})) },
        setMetadata: { mutate: vi.fn(async () => {}) },
      },
    },
    logger,
  } as unknown as DeviceContext
  const device = new HaSwitchDevice(ctx)
  const push = (key: string, state: string, attributes: Record<string, unknown>): void => {
    for (const handler of handlers) {
      handler({
        data: {
          brokerId: 'b1',
          key,
          payload: {
            entity_id: key,
            state,
            attributes,
            last_changed: '2026-01-01T00:00:00Z',
            last_updated: '2026-01-01T00:00:01Z',
          },
        },
      })
    }
  }
  const status = (): PowerMeterStatus | undefined =>
    device.runtimeState.getCapState<PowerMeterStatus>('power-meter')
  return { device, names, subscribe, push, status }
}

const BASE = {
  brokerId: 'b1',
  entityId: 'switch.desk_plug',
  capabilities: ['switch', 'power-meter'],
}
const METERS = { watts: 'sensor.desk_power', kwhTotal: 'sensor.desk_energy' }

describe('a switch that carries its sibling meter sensors', () => {
  it('registers power-meter next to the switch', () => {
    const { names } = build({ ...BASE, meterEntities: METERS })
    expect(names).toContain('switch')
    expect(names).toContain('power-meter')
  })

  it('is a plain switch without meter entities', () => {
    const { names } = build({ ...BASE, capabilities: ['switch'] })
    expect(names).not.toContain('power-meter')
  })

  it('subscribes to its own entity and to every meter entity', async () => {
    const { device, subscribe } = build({ ...BASE, meterEntities: METERS })
    await device.onActivate()
    expect(subscribe).toHaveBeenCalledWith({
      brokerId: 'b1',
      filter: {
        entityIds: ['switch.desk_plug', 'sensor.desk_power', 'sensor.desk_energy'],
      },
    })
  })

  it('writes each meter push into its field, in base units, without touching the switch', () => {
    const { push, status } = build({ ...BASE, meterEntities: METERS })
    push('sensor.desk_power', '1.5', { device_class: 'power', unit_of_measurement: 'kW' })
    push('sensor.desk_energy', '12.5', { device_class: 'energy', unit_of_measurement: 'kWh' })
    expect(status()?.watts).toBeCloseTo(1500)
    expect(status()?.kwhTotal).toBe(12.5)
  })

  it('ignores an unavailable meter and keeps the last reading', () => {
    const { push, status } = build({ ...BASE, meterEntities: METERS })
    push('sensor.desk_power', '40', { device_class: 'power', unit_of_measurement: 'W' })
    push('sensor.desk_power', 'unavailable', {})
    expect(status()?.watts).toBe(40)
  })
})
