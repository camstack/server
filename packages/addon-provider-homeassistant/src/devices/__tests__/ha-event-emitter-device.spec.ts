import { describe, it, expect, vi } from 'vitest'
import {
  DeviceType,
  type DeviceContext,
  type IDeviceRuntimeState,
  type IScopedLogger,
  type EventEmitterStatus,
} from '@camstack/types'
import { HaEventEmitterDevice } from '../ha-event-emitter-device.js'

const ENTITY_ID = 'event.pulsante_luce_porch_ch1'
const BROKER_ID = 'broker-ha'
const VOCAB = ['press_long_release', 'press_short', 'press_long_start', 'press_long'] as const

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

/** Narrow, fully-typed handle onto the parts of a DeviceContext this spec
 *  drives. The harness reads/writes only through these typed handles —
 *  no `as any` attribute access anywhere. */
interface EventEmitterHarness {
  readonly device: HaEventEmitterDevice
  /** The real IDeviceRuntimeState the BaseDevice bound (kernel-shaped). */
  runtimeState(): IDeviceRuntimeState | null
  /** Names passed to registerNativeCap. */
  readonly registeredCapNames: readonly string[]
  /** Invoke the captured event-bus handler with an HA state push. */
  push(payload: { state: string; attributes: Record<string, unknown> }): void
  /** Spy on eventBus.emit so we can assert the fired EventFire payload. */
  readonly emit: ReturnType<typeof vi.fn>
}

/** Build the HA `event.*` state envelope. `state` is the ISO timestamp of
 *  the last fire (advances on every press). */
function isoEnvelope(
  state: string,
  attributes: Record<string, unknown>,
): { state: string; attributes: Record<string, unknown> } {
  return { state, attributes }
}

/** Typed IScopedLogger fake — every method is a no-op spy and the
 *  scope-deriving methods return the same fake (satisfies the interface
 *  with no casts). */
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

function buildHarness(): EventEmitterHarness {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  let eventHandler: ((event: { data: unknown }) => void) | null = null
  const emit = vi.fn()
  const registeredCapNames: string[] = []

  const eventBus = {
    emit,
    subscribe: vi.fn((_filter: unknown, handler: (event: { data: unknown }) => void) => {
      eventHandler = handler
      return () => {}
    }),
    getRecent: vi.fn(() => []),
  }

  // Mirrors the established HA device-spec mock harness: the production
  // DeviceContext carries opaque generated types (AddonApi =
  // CreateTRPCClient<AppRouter>, DeviceProxy, generic DeviceManagerApi)
  // that cannot be constructed structurally in a unit test, so the whole
  // stub crosses one documented type boundary. All meaningful assertions
  // below go through fully-typed handles + type guards (no `as any`).
  const ctx = {
    id: 42,
    stableId: 'ha:event:42',
    parentDeviceId: null,
    deviceMeta: {
      id: 42,
      stableId: 'ha:event:42',
      type: DeviceType.EventEmitter,
      name: 'Pulsante Luce Porch Ch1',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {
      brokerId: BROKER_ID,
      entityId: ENTITY_ID,
      capabilities: ['event-emitter'],
    },
    initialRuntimeState: {},
    eventBus,
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 42),
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
    api: {
      broker: {
        publish: { mutate: vi.fn(async () => null) },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-evt-1' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
        getState: { query: vi.fn(async () => null) },
      },
      deviceManager: {
        registerDevice: { mutate: vi.fn(async () => ({})) },
      },
    },
    logger: makeLogger(),
  } as unknown as DeviceContext

  const device = new HaEventEmitterDevice(ctx)

  return {
    device,
    runtimeState: () => runtimeStateRef,
    registeredCapNames,
    emit,
    push: (payload) => {
      if (!eventHandler) throw new Error('event handler not attached')
      eventHandler({
        data: {
          brokerId: BROKER_ID,
          key: ENTITY_ID,
          payload: { last_changed: payload.state, last_updated: payload.state, ...payload },
        },
      })
    },
  }
}

/** Read the typed event-emitter slice from the real runtime state. */
function readSlice(h: EventEmitterHarness): EventEmitterStatus | null {
  return h.runtimeState()?.getCapState<EventEmitterStatus>('event-emitter') ?? null
}

/** Type guard for a fired `event-emitter.event` bus event. */
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

/** The most-recently emitted bus event, narrowed to FiredEvent, or null. */
function lastFiredEvent(emit: ReturnType<typeof vi.fn>): FiredEvent | null {
  const calls = emit.mock.calls
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const evt: unknown = calls[i]?.[0]
    if (isFiredEvent(evt)) return evt
  }
  return null
}

describe('HaEventEmitterDevice', () => {
  it('registers the "event-emitter" cap on activation', async () => {
    const h = buildHarness()
    await h.device.onActivate()
    expect(h.registeredCapNames).toContain('event-emitter')
  })

  it('seeds the slice with the verbatim event_types from the live entity', async () => {
    const h = buildHarness()
    await h.device.onActivate()
    // First push = cache replay (entity CURRENT state) → baseline, no fire.
    h.push(
      isoEnvelope('2026-06-05T10:00:00.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_short',
      }),
    )
    const slice = readSlice(h)
    expect(slice).not.toBeNull()
    // Vocabulary is VERBATIM — exact tokens, exact order, NO normalization.
    expect(slice?.eventTypes).toEqual([...VOCAB])
    expect(slice?.lastEvent).toBeNull()
    expect(slice?.eventCountSinceStart).toBe(0)
    // Replay must NOT emit a bus event.
    expect(lastFiredEvent(h.emit)).toBeNull()
  })

  it('emits the verbatim eventType on a fire and increments seq/count', async () => {
    const h = buildHarness()
    await h.device.onActivate()
    // Baseline replay.
    h.push(
      isoEnvelope('2026-06-05T10:00:00.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_short',
      }),
    )
    // Real fire: timestamp ADVANCES + new event_type token.
    h.push(
      isoEnvelope('2026-06-05T10:00:05.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_long',
      }),
    )

    const fired = lastFiredEvent(h.emit)
    expect(fired).not.toBeNull()
    expect(fired?.category).toBe('event-emitter.event')
    expect(fired?.data.eventType).toBe('press_long') // VERBATIM token
    expect(fired?.data.data).toBeNull() // Case 1 → no complex payload
    expect(fired?.data.deviceId).toBe(42)
    expect(fired?.data.seq).toBe(1)

    const slice = readSlice(h)
    expect(slice?.lastEvent?.eventType).toBe('press_long')
    expect(slice?.lastEvent?.seq).toBe(1)
    expect(slice?.eventCountSinceStart).toBe(1)

    // Second fire → seq + count both advance.
    h.push(
      isoEnvelope('2026-06-05T10:00:09.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_short',
      }),
    )
    const fired2 = lastFiredEvent(h.emit)
    expect(fired2?.data.eventType).toBe('press_short')
    expect(fired2?.data.seq).toBe(2)
    expect(readSlice(h)?.eventCountSinceStart).toBe(2)
  })

  it('emits nothing when the timestamp is unchanged (attribute-only update)', async () => {
    const h = buildHarness()
    await h.device.onActivate()
    h.push(
      isoEnvelope('2026-06-05T10:00:00.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_short',
      }),
    )
    const before = h.emit.mock.calls.length
    // Same state timestamp, even with a different event_type → not a new fire.
    h.push(
      isoEnvelope('2026-06-05T10:00:00.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_long',
      }),
    )
    expect(h.emit.mock.calls.length).toBe(before)
    expect(readSlice(h)?.eventCountSinceStart).toBe(0)
  })

  it('emits nothing when event_type is missing on an advancing push', async () => {
    const h = buildHarness()
    await h.device.onActivate()
    h.push(
      isoEnvelope('2026-06-05T10:00:00.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_short',
      }),
    )
    const before = h.emit.mock.calls.length
    // Timestamp advanced but no event_type token.
    h.push(isoEnvelope('2026-06-05T10:00:05.000+00:00', { event_types: [...VOCAB] }))
    expect(h.emit.mock.calls.length).toBe(before)
    expect(readSlice(h)?.eventCountSinceStart).toBe(0)
    // ...and a subsequent genuine fire is NOT mistaken for a repeat.
    h.push(
      isoEnvelope('2026-06-05T10:00:09.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_long',
      }),
    )
    expect(lastFiredEvent(h.emit)?.data.eventType).toBe('press_long')
    expect(lastFiredEvent(h.emit)?.data.seq).toBe(1)
  })

  it('skips unavailable / unknown states', async () => {
    const h = buildHarness()
    await h.device.onActivate()
    h.push(
      isoEnvelope('2026-06-05T10:00:00.000+00:00', {
        event_types: [...VOCAB],
        event_type: 'press_short',
      }),
    )
    const before = h.emit.mock.calls.length
    h.push({ state: 'unavailable', attributes: {} })
    h.push({ state: 'unknown', attributes: {} })
    expect(h.emit.mock.calls.length).toBe(before)
  })
})
