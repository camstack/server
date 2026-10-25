/**
 * HaSwitchDevice seed + push contract.
 *
 * A stored `on: true` overwritten with `false` on construct is a false
 * falling edge: composer `rose` on a HA doorbell switch re-fires when HA
 * then pushes the real `on` after every provider restart.
 */
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HaSwitchDevice } from '../ha-switch-device.js'
import type { HaEntityState } from '../../ha-types.js'

const BROKER_ID = 'ha-main'
const ENTITY_ID = 'switch.doorbell_bussano'
const DEVICE_ID = 1031
const T1 = 1_700_000_000_000

type BrokerMessageHandler = (event: { readonly data: unknown }) => void

function haState(state: string, lastChangedAtMs: number): HaEntityState {
  const iso = new Date(lastChangedAtMs).toISOString()
  return {
    entity_id: ENTITY_ID,
    state,
    attributes: {},
    last_changed: iso,
    last_updated: iso,
  }
}

function makeSwitch(initialRuntimeState: Record<string, unknown> = {}): {
  readonly slice: () => { on: boolean; lastChangedAt: number } | undefined
  readonly push: (state: string, lastChangedAtMs: number) => void
} {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const handlers: BrokerMessageHandler[] = []

  const ctx = {
    id: DEVICE_ID,
    stableId: `ha:test:${DEVICE_ID}`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Switch,
      name: 'Doorbell bussano',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: { brokerId: BROKER_ID, entityId: ENTITY_ID, capabilities: ['switch'] },
    initialRuntimeState,
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn((_filter: unknown, handler: BrokerMessageHandler) => {
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
    registerNativeCap: vi.fn(
      (cap: { name: string; runtimeState?: unknown }, _provider: unknown) => {
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-1' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
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

  const device = new HaSwitchDevice(ctx)
  return {
    slice: () => device.runtimeState.getCapState<{ on: boolean; lastChangedAt: number }>('switch'),
    push: (state, lastChangedAtMs) => {
      const data = { brokerId: BROKER_ID, key: ENTITY_ID, payload: haState(state, lastChangedAtMs) }
      for (const handler of handlers) handler({ data })
    },
  }
}

describe('HaSwitchDevice', () => {
  it('keeps a stored active level through the constructor seed (no false fall)', () => {
    const h = makeSwitch({ switch: { on: true, lastChangedAt: T1 } })
    expect(h.slice()).toEqual({ on: true, lastChangedAt: T1 })
  })

  it('seeds off when nothing was stored', () => {
    const h = makeSwitch({})
    expect(h.slice()).toEqual({ on: false, lastChangedAt: 0 })
  })

  it('ignores unavailable / unknown pushes (no invented off)', () => {
    const h = makeSwitch({ switch: { on: true, lastChangedAt: T1 } })
    h.push('unavailable', T1 + 1_000)
    h.push('unknown', T1 + 2_000)
    expect(h.slice()).toEqual({ on: true, lastChangedAt: T1 })
  })

  it('applies a real on/off push after the seed', () => {
    const h = makeSwitch({ switch: { on: true, lastChangedAt: T1 } })
    h.push('off', T1 + 5_000)
    expect(h.slice()).toEqual({ on: false, lastChangedAt: T1 + 5_000 })
    h.push('on', T1 + 6_000)
    expect(h.slice()).toEqual({ on: true, lastChangedAt: T1 + 6_000 })
  })
})
