/**
 * Test harness for `HaBinarySensorDevice`: builds the device over a stub
 * `DeviceContext` whose runtime state is the REAL `DeviceRuntimeState` (the
 * base device builds it; the stub installs each cap's real schema, as the
 * kernel does), and pushes HA states through the SAME `broker.message`
 * listener the integration manager feeds in production.
 */
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { vi } from 'vitest'
import { HaBinarySensorDevice } from '../ha-binary-sensor-device.js'
import type { HaEntityState } from '../../ha-types.js'

export const BROKER_ID = 'ha-main'
export const ENTITY_ID = 'binary_sensor.sensore_movimento_porch_motion'
export const SENSOR_ID = 3299

/** The cap slice as the runtime state holds it. */
export type SliceRecord = Readonly<Record<string, unknown>>

/** A `broker.message` handler, as `HaBaseChildDevice` subscribes it. */
type BrokerMessageHandler = (event: { readonly data: unknown }) => void

/** The provider `registerNativeCap` was handed for `motion`. */
interface MotionProvider {
  readonly getStatus: (input: unknown) => Promise<unknown>
}

export interface BinarySensorHarness {
  readonly device: HaBinarySensorDevice
  /** The logger the device writes through (its `deviceLogger`: no integration tag here). */
  readonly logger: { readonly info: ReturnType<typeof vi.fn> }
  /** Push an HA state at the device exactly as the event bus would. */
  readonly push: (state: string, lastChangedAtMs: number) => void
  /** The current slice of the hosted cap, as the device's runtime state holds it. */
  readonly slice: () => SliceRecord | undefined
  /** The registered `motion` provider's `getStatus`. */
  readonly getStatus: () => Promise<unknown>
}

export function haState(
  state: string,
  lastChangedAtMs: number,
  deviceClass = 'motion',
): HaEntityState {
  const iso = new Date(lastChangedAtMs).toISOString()
  return {
    entity_id: ENTITY_ID,
    state,
    attributes: { device_class: deviceClass },
    last_changed: iso,
    last_updated: iso,
  }
}

export function makeMotionSensor(
  initialRuntimeState: Record<string, unknown> = {},
): BinarySensorHarness {
  return makeBinarySensor('motion', initialRuntimeState)
}

/** A binary sensor hosting `capName` (`motion`, `contact`, …), as the factory builds one. */
export function makeBinarySensor(
  capName: string,
  initialRuntimeState: Record<string, unknown> = {},
): BinarySensorHarness {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  let motionProvider: MotionProvider | null = null
  const handlers: BrokerMessageHandler[] = []
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }

  const ctx = {
    id: SENSOR_ID,
    stableId: `ha:test:${SENSOR_ID}`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Sensor,
      name: 'PIR porch',
      location: null,
      disabled: false,
      addonId: 'homeassistant',
      metadata: {},
    },
    persistedConfig: { brokerId: BROKER_ID, entityId: ENTITY_ID, capabilities: [capName] },
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
      (cap: { name: string; runtimeState?: unknown }, provider: MotionProvider) => {
        if (cap.name === capName) motionProvider = provider
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
    logger,
    // Test boundary: the stub carries only what the device reads.
  } as unknown as import('@camstack/types').DeviceContext

  const device = new HaBinarySensorDevice(ctx)
  return {
    device,
    logger,
    push: (state, lastChangedAtMs) => {
      const payload = haState(state, lastChangedAtMs, capName)
      const data = { brokerId: BROKER_ID, key: ENTITY_ID, payload }
      for (const handler of handlers) handler({ data })
    },
    slice: () => device.runtimeState.getCapState(capName),
    getStatus: async () => {
      if (motionProvider === null) throw new Error('motion provider was never registered')
      return motionProvider.getStatus({ deviceId: SENSOR_ID })
    },
  }
}
