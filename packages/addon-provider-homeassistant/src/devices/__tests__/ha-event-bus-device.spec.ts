import { describe, it, expect, vi } from 'vitest'
import {
  DeviceType,
  type DeviceContext,
  type IDeviceRuntimeState,
  type IScopedLogger,
  type EventEmitterStatus,
} from '@camstack/types'
import { HaEventBusDevice } from '../ha-event-bus-device.js'

const BROKER_ID = 'ha_001'

/** Shape of a fired `event-emitter.event` bus event, for type-guarded reads. */
interface FiredEvent {
  readonly category: string
  readonly data: {
    readonly eventType: string
    readonly seq: number
    readonly data: Record<string, unknown> | null
    readonly deviceId: number
  }
}

interface BusDeviceHarness {
  readonly device: HaEventBusDevice
  runtimeState(): IDeviceRuntimeState | null
  readonly registeredCapNames: readonly string[]
  readonly emit: ReturnType<typeof vi.fn>
}

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function buildHarness(): BusDeviceHarness {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const emit = vi.fn()
  const registeredCapNames: string[] = []

  const eventBus = {
    emit,
    subscribe: vi.fn(() => () => {}),
    getRecent: vi.fn(() => []),
  }

  // Mirrors the established HA device-spec mock harness: the production
  // DeviceContext carries opaque generated types that cannot be constructed
  // structurally in a unit test, so the whole stub crosses one documented type
  // boundary. All meaningful assertions go through fully-typed handles + type
  // guards (no `as any`).
  const ctx = {
    id: 7,
    stableId: `ha:${BROKER_ID}:events`,
    parentDeviceId: null,
    deviceMeta: {
      id: 7,
      stableId: `ha:${BROKER_ID}:events`,
      type: DeviceType.EventEmitter,
      name: 'Home Assistant Events',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {
      system: 'homeassistant',
      brokerId: BROKER_ID,
      kind: 'event-bus',
    },
    initialRuntimeState: {},
    eventBus,
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 7),
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
      registeredCapNames.push(cap.name)
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {},
    logger: makeLogger(),
  } as unknown as DeviceContext

  const device = new HaEventBusDevice(ctx)

  return {
    device,
    runtimeState: () => runtimeStateRef,
    registeredCapNames,
    emit,
  }
}

function readSlice(h: BusDeviceHarness): EventEmitterStatus | null {
  return h.runtimeState()?.getCapState<EventEmitterStatus>('event-emitter') ?? null
}

function isFiredEvent(value: unknown): value is FiredEvent {
  if (typeof value !== 'object' || value === null) return false
  const v: Record<string, unknown> = value as Record<string, unknown>
  if (typeof v['category'] !== 'string') return false
  const d = v['data']
  if (typeof d !== 'object' || d === null) return false
  const dd: Record<string, unknown> = d as Record<string, unknown>
  return (
    typeof dd['eventType'] === 'string' &&
    typeof dd['seq'] === 'number' &&
    typeof dd['deviceId'] === 'number'
  )
}

function lastFiredEvent(emit: ReturnType<typeof vi.fn>): FiredEvent | null {
  const calls = emit.mock.calls
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const evt: unknown = calls[i]?.[0]
    if (isFiredEvent(evt)) return evt
  }
  return null
}

describe('HaEventBusDevice (Case 2 — generic aggregator)', () => {
  it('registers the "event-emitter" cap on activation with an OPEN vocabulary', async () => {
    const h = buildHarness()
    await h.device.onActivate()
    expect(h.registeredCapNames).toContain('event-emitter')
    const slice = readSlice(h)
    expect(slice).not.toBeNull()
    expect(slice?.eventTypes).toEqual([])
    expect(slice?.lastEvent).toBeNull()
    expect(slice?.eventCountSinceStart).toBe(0)
  })

  it('emits the verbatim eventType + complex data on a bus event', async () => {
    const h = buildHarness()
    await h.device.onActivate()

    const payload = { device_ieee: '00:11', command: 'press', args: [1, 2] }
    h.device.handleBusEvent({ eventType: 'zha_event', data: payload })

    const fired = lastFiredEvent(h.emit)
    expect(fired).not.toBeNull()
    expect(fired?.category).toBe('event-emitter.event')
    expect(fired?.data.eventType).toBe('zha_event') // VERBATIM bus event type
    expect(fired?.data.data).toEqual(payload) // VERBATIM payload — NO normalization
    expect(fired?.data.deviceId).toBe(7)
    expect(fired?.data.seq).toBe(1)

    const slice = readSlice(h)
    expect(slice?.eventTypes).toEqual([]) // vocabulary stays OPEN
    expect(slice?.lastEvent?.eventType).toBe('zha_event')
    expect(slice?.lastEvent?.data).toEqual(payload)
    expect(slice?.lastEvent?.seq).toBe(1)
    expect(slice?.eventCountSinceStart).toBe(1)
  })

  it('increments seq + count on every subsequent bus event', async () => {
    const h = buildHarness()
    await h.device.onActivate()

    h.device.handleBusEvent({ eventType: 'zha_event', data: { command: 'on' } })
    h.device.handleBusEvent({ eventType: 'deconz_event', data: { command: 'off' } })

    const fired = lastFiredEvent(h.emit)
    expect(fired?.data.eventType).toBe('deconz_event')
    expect(fired?.data.seq).toBe(2)
    expect(readSlice(h)?.eventCountSinceStart).toBe(2)
    // Vocabulary never narrows even across distinct event types.
    expect(readSlice(h)?.eventTypes).toEqual([])
  })

  it('carries data: null verbatim when the bus event has no payload', async () => {
    const h = buildHarness()
    await h.device.onActivate()

    h.device.handleBusEvent({ eventType: 'xiaomi_aqara.click', data: null })

    const fired = lastFiredEvent(h.emit)
    expect(fired?.data.eventType).toBe('xiaomi_aqara.click')
    expect(fired?.data.data).toBeNull()
    expect(readSlice(h)?.lastEvent?.data).toBeNull()
  })
})
