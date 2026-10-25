import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type AddonContext, type IDevice } from '@camstack/types'
import { HaProviderAddon } from '../addon.js'
import { HaEventBusDevice, type HaBusEvent } from '../devices/ha-event-bus-device.js'

const BROKER_ID = 'ha_001'
const AGG_STABLE_ID = `ha:${BROKER_ID}:events`
const AGG_DEVICE_ID = 7

/** Internal surface of the addon this spec drives. The private aggregator
 *  methods + `_ctx`/`eventBusDeviceIds` are reached via this typed handle,
 *  mirroring the established HA addon-spec injection convention. */
interface AggregatorInternal {
  _ctx: AddonContext
  ensureEventBusDevice(brokerId: string): Promise<number>
  routeBusEvent(brokerId: string, ev: HaBusEvent): Promise<void>
  eventBusDeviceIds: Map<string, number>
}

/** A stand-in live aggregator device — a REAL HaEventBusDevice is hard to
 *  fully construct here, so we expose just the registry-resolvable shape the
 *  router needs and spy on `handleBusEvent`. The router narrows via
 *  `instanceof HaEventBusDevice`, so the device returned by the registry must
 *  be a real instance — see `makeAggregatorInstance`. */
interface Harness {
  internal: AggregatorInternal
  create: ReturnType<typeof vi.fn>
  getAll: ReturnType<typeof vi.fn>
  getById: ReturnType<typeof vi.fn>
  aggregator: HaEventBusDevice
  handleBusEvent: ReturnType<typeof vi.fn>
}

/** Construct a real HaEventBusDevice via Object.create (bypassing the heavy
 *  DeviceContext constructor) and stamp the fields the router reads + a spy
 *  for `handleBusEvent`. `instanceof HaEventBusDevice` holds because the
 *  prototype is preserved. */
function makeAggregatorInstance(handleBusEvent: ReturnType<typeof vi.fn>): HaEventBusDevice {
  const instance: HaEventBusDevice = Object.create(HaEventBusDevice.prototype)
  Object.defineProperty(instance, 'handleBusEvent', { value: handleBusEvent })
  return instance
}

function buildHarness(): Harness {
  const handleBusEvent = vi.fn()
  const aggregator = makeAggregatorInstance(handleBusEvent)

  // A fresh aggregator is "created" on first ensure; subsequent ensures must
  // NOT call create again (idempotent on stableId).
  const created: IDevice[] = []
  const create = vi.fn(async (stableId: string) => {
    const device = { id: AGG_DEVICE_ID, stableId } as unknown as IDevice
    created.push(device)
    return device
  })
  const getAll = vi.fn(async (): Promise<readonly IDevice[]> => created)
  const getById = vi.fn((id: number): IDevice | null => (id === AGG_DEVICE_ID ? aggregator : null))

  const kernel = {
    localNodeId: 'hub',
    devices: { create, getAll, getChildren: vi.fn(async () => []) },
    deviceRegistry: { getById },
  }
  const ctx = {
    id: 'provider-homeassistant',
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel,
    api: {},
  } as unknown as AddonContext

  const addon = new HaProviderAddon()
  const internal = addon as unknown as AggregatorInternal
  internal._ctx = ctx

  return { internal, create, getAll, getById, aggregator, handleBusEvent }
}

describe('HaProviderAddon — bus-event aggregator (Case 2)', () => {
  it('ensureEventBusDevice creates the aggregator once and is idempotent', async () => {
    const h = buildHarness()

    const id1 = await h.internal.ensureEventBusDevice(BROKER_ID)
    expect(id1).toBe(AGG_DEVICE_ID)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.create).toHaveBeenCalledWith(
      AGG_STABLE_ID,
      HaEventBusDevice,
      { system: 'homeassistant', brokerId: BROKER_ID, kind: 'event-bus' },
      null,
      { type: DeviceType.EventEmitter, name: 'Home Assistant Events' },
    )

    // Second call → cache hit, no second create.
    const id2 = await h.internal.ensureEventBusDevice(BROKER_ID)
    expect(id2).toBe(AGG_DEVICE_ID)
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it('ensureEventBusDevice reuses an existing device (restore path) without creating', async () => {
    const h = buildHarness()
    // Simulate a restored aggregator already present in the registry.
    h.getAll.mockResolvedValueOnce([
      { id: AGG_DEVICE_ID, stableId: AGG_STABLE_ID } as unknown as IDevice,
    ])

    const id = await h.internal.ensureEventBusDevice(BROKER_ID)
    expect(id).toBe(AGG_DEVICE_ID)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('routeBusEvent reaches the live aggregator instance with the verbatim event', async () => {
    const h = buildHarness()
    await h.internal.ensureEventBusDevice(BROKER_ID)

    const ev: HaBusEvent = { eventType: 'zha_event', data: { command: 'press', args: [1] } }
    await h.internal.routeBusEvent(BROKER_ID, ev)

    expect(h.handleBusEvent).toHaveBeenCalledTimes(1)
    expect(h.handleBusEvent).toHaveBeenCalledWith(ev)
  })

  it('routeBusEvent lazily creates the aggregator when not ensured yet', async () => {
    const h = buildHarness()
    // No prior ensureEventBusDevice — routeBusEvent must create on demand.
    await h.internal.routeBusEvent(BROKER_ID, { eventType: 'deconz_event', data: null })

    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.handleBusEvent).toHaveBeenCalledWith({ eventType: 'deconz_event', data: null })
  })

  // ── Restore-race tolerance ───────────────────────────────────────────────────

  it('ensureEventBusDevice tolerates "already registered" from create (Pass-1 restore beat it)', async () => {
    // Simulate the race: getAll() is empty before create (no pre-existing device
    // visible yet), but create throws "already registered" because Pass-1 restore
    // completed between the getAll check and the create call. The second getAll
    // (inside the catch) returns the now-restored aggregator.
    const handleBusEvent = vi.fn()
    const aggregator = makeAggregatorInstance(handleBusEvent)

    const restoredDevice = { id: AGG_DEVICE_ID, stableId: AGG_STABLE_ID } as unknown as IDevice

    const create = vi.fn(async () => {
      throw new Error(
        `Device numeric id 101 already registered (stableId=${AGG_STABLE_ID}); attempted to register ${AGG_STABLE_ID}`,
      )
    })
    // First getAll (pre-create check) returns empty — race not yet resolved.
    // Second getAll (post-catch recovery) returns the restored aggregator.
    const getAll = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([restoredDevice])
    const getById = vi.fn((id: number): IDevice | null =>
      id === AGG_DEVICE_ID ? aggregator : null,
    )

    const kernel = {
      localNodeId: 'hub',
      devices: { create, getAll, getChildren: vi.fn(async () => []) },
      deviceRegistry: { getById },
    }
    const ctx = {
      id: 'provider-homeassistant',
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
      },
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      kernel,
      api: {},
    } as unknown as AddonContext

    const addon = new HaProviderAddon()
    const internal = addon as unknown as AggregatorInternal
    internal._ctx = ctx

    // Must resolve to the restored device id WITHOUT throwing.
    const id = await internal.ensureEventBusDevice(BROKER_ID)
    expect(id).toBe(AGG_DEVICE_ID)
    // create was attempted exactly once.
    expect(create).toHaveBeenCalledTimes(1)
    // The id is now cached — a second call is a pure no-op (no create, no getAll).
    const cachedId = await internal.ensureEventBusDevice(BROKER_ID)
    expect(cachedId).toBe(AGG_DEVICE_ID)
    expect(create).toHaveBeenCalledTimes(1)
    // getAll called twice: once for the pre-create check, once inside the catch.
    expect(getAll).toHaveBeenCalledTimes(2)
    // The cache is populated — routeBusEvent can now resolve it.
    expect(internal.eventBusDeviceIds.get(BROKER_ID)).toBe(AGG_DEVICE_ID)
  })

  it('ensureEventBusDevice re-throws non-duplicate errors from create', async () => {
    const create = vi.fn(async () => {
      throw new Error('kernel unavailable')
    })
    const getAll = vi.fn(async (): Promise<readonly IDevice[]> => [])
    const kernel = {
      localNodeId: 'hub',
      devices: { create, getAll, getChildren: vi.fn(async () => []) },
      deviceRegistry: { getById: vi.fn(() => null) },
    }
    const ctx = {
      id: 'provider-homeassistant',
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
      },
      eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      kernel,
      api: {},
    } as unknown as AddonContext

    const addon = new HaProviderAddon()
    const internal = addon as unknown as AggregatorInternal
    internal._ctx = ctx

    await expect(internal.ensureEventBusDevice(BROKER_ID)).rejects.toThrow('kernel unavailable')
  })
})
