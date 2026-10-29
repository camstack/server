/**
 * Per-device event rings — the history one camera's Events panel reads.
 *
 * The bug these bite on: the retaining bus kept ONE global, count-bounded ring,
 * so a per-device ask was answered by FILTERING it — and on a 16 events/s fleet
 * the quiet camera being asked about had already been evicted by its 31 noisy
 * siblings. Every test here fails if the per-device ring, the mirror coalescing
 * or the payload cap is removed.
 */
import type { SystemEvent } from '@camstack/types'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSharedBusState,
  deliverShared,
  MAX_RECENT_EVENTS,
} from '../../moleculer/event-bus-core.js'
import {
  capEventData,
  eventDeviceId,
  getDeviceRecent,
  isTruncatedEventData,
  MAX_DEVICE_RING_EVENTS,
  MAX_RETAINED_DATA_BYTES,
  MIRROR_CATEGORIES,
  isMirrorCategory,
} from '../../moleculer/device-event-ring.js'
import { getBrokerEventBus } from '../../moleculer/event-bus.js'

let seq = 0

function deviceEvent(
  deviceId: number,
  category: string,
  data: Record<string, unknown> = {},
): SystemEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    timestamp: new Date(seq),
    source: { type: 'device', id: deviceId, deviceId },
    category,
    data,
  }
}

function unattributedEvent(category: string): SystemEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    timestamp: new Date(seq),
    source: { type: 'addon', id: 'homeassistant' },
    category,
    data: { brokerId: 'ha-1', subscriptionId: 'sub-1', key: 'sensor.x' },
  }
}

describe('device-event-ring — declared mirror set', () => {
  it('declares a REASON for every mirror category, and nothing else is a mirror', () => {
    expect(MIRROR_CATEGORIES.length).toBeGreaterThan(0)
    for (const m of MIRROR_CATEGORIES) {
      expect(m.category.length).toBeGreaterThan(0)
      expect(m.reason.trim().length).toBeGreaterThan(20)
      expect(isMirrorCategory(m.category)).toBe(true)
    }
    // An unclassified category defaults to NOT coalesced — keeping history is
    // the safe default; collapsing a category nobody classified would lose data
    // nobody decided to lose.
    expect(isMirrorCategory('addon.crashed')).toBe(false)
    expect(isMirrorCategory('provider.detection')).toBe(false)
  })
})

describe('device-event-ring — a quiet camera survives a busy fleet', () => {
  it('keeps a quiet device`s events after the GLOBAL ring has evicted them', () => {
    const state = createSharedBusState(true)

    // The quiet camera speaks first…
    for (let i = 0; i < 3; i++) {
      deliverShared(state, deviceEvent(42, 'provider.detection', { i }))
    }
    // …then the rest of the fleet buries it in the global ring.
    for (let i = 0; i < MAX_RECENT_EVENTS + 500; i++) {
      deliverShared(state, deviceEvent(900 + (i % 31), 'provider.detection', { i }))
    }

    // The global ring no longer holds ANY of device 42's events — this is the
    // measured production symptom, and filtering it cannot undo it.
    const survivorsInGlobalRing = state.recent.filter((e) => e.source.deviceId === 42)
    expect(survivorsInGlobalRing.length).toBe(0)

    // The per-device ring still has all three.
    const perDevice = getDeviceRecent(state.deviceRings, 42)
    expect(perDevice.length).toBe(3)
    expect(perDevice.map((e) => e.category)).toEqual([
      'provider.detection',
      'provider.detection',
      'provider.detection',
    ])
  })

  it('bounds each device ring at MAX_DEVICE_RING_EVENTS, newest kept', () => {
    const state = createSharedBusState(true)
    for (let i = 0; i < MAX_DEVICE_RING_EVENTS + 250; i++) {
      deliverShared(state, deviceEvent(7, 'provider.detection', { i }))
    }
    const ring = getDeviceRecent(state.deviceRings, 7)
    expect(ring.length).toBe(MAX_DEVICE_RING_EVENTS)
    expect(ring.at(-1)?.data.i).toBe(MAX_DEVICE_RING_EVENTS + 249)
  })

  it('a device that emitted nothing answers with [] — not with someone else`s events', () => {
    const state = createSharedBusState(true)
    deliverShared(state, deviceEvent(1, 'provider.detection'))
    expect(getDeviceRecent(state.deviceRings, 2)).toEqual([])
  })
})

describe('device-event-ring — mirror coalescing', () => {
  it('keeps only the LATEST event per (device, mirror category)', () => {
    const state = createSharedBusState(true)
    for (let i = 0; i < 500; i++) {
      deliverShared(state, deviceEvent(42, 'device.state-changed', { i }))
      deliverShared(state, deviceEvent(42, 'camera-streams.onCamStreamsChanged', { i }))
    }
    const ring = getDeviceRecent(state.deviceRings, 42)
    // 1 000 mirror emissions → 2 retained slots, one per category.
    expect(ring.length).toBe(2)
    const byCategory = new Map(ring.map((e) => [e.category, e]))
    expect(byCategory.get('device.state-changed')?.data.i).toBe(499)
    expect(byCategory.get('camera-streams.onCamStreamsChanged')?.data.i).toBe(499)
  })

  it('does NOT coalesce an unclassified category', () => {
    const state = createSharedBusState(true)
    for (let i = 0; i < 10; i++) {
      deliverShared(state, deviceEvent(42, 'addon.crashed', { i }))
    }
    expect(getDeviceRecent(state.deviceRings, 42).length).toBe(10)
  })

  it('coalescing is per DEVICE — one camera`s mirror never replaces another`s', () => {
    const state = createSharedBusState(true)
    deliverShared(state, deviceEvent(42, 'device.state-changed', { who: 42 }))
    deliverShared(state, deviceEvent(43, 'device.state-changed', { who: 43 }))
    expect(getDeviceRecent(state.deviceRings, 42)[0]?.data.who).toBe(42)
    expect(getDeviceRecent(state.deviceRings, 43)[0]?.data.who).toBe(43)
  })

  it('a mirror is merged into history in timestamp order', () => {
    const state = createSharedBusState(true)
    deliverShared(state, deviceEvent(42, 'provider.detection', { n: 1 }))
    deliverShared(state, deviceEvent(42, 'device.state-changed', { n: 2 }))
    deliverShared(state, deviceEvent(42, 'provider.detection', { n: 3 }))
    expect(getDeviceRecent(state.deviceRings, 42).map((e) => e.data.n)).toEqual([1, 2, 3])
  })
})

describe('device-event-ring — events with no deviceId', () => {
  it('stays in the GLOBAL ring and fabricates no device', () => {
    const state = createSharedBusState(true)
    for (let i = 0; i < 5; i++)
      deliverShared(state, unattributedEvent('broker.unattributed-sample'))

    // Retained globally, exactly as before.
    expect(state.recent.filter((e) => e.category === 'broker.unattributed-sample').length).toBe(5)
    // …and it created no device bucket at all.
    expect(state.deviceRings.byDevice.size).toBe(0)
    expect(eventDeviceId(unattributedEvent('broker.unattributed-sample'))).toBeUndefined()
  })

  it('a non-numeric device source id is unattributable, not a bucket of its own', () => {
    seq += 1
    const event: SystemEvent = {
      id: `evt-${seq}`,
      timestamp: new Date(seq),
      source: { type: 'device', id: 'not-a-number' },
      category: 'provider.detection',
      data: {},
    }
    expect(eventDeviceId(event)).toBeUndefined()
    const state = createSharedBusState(true)
    deliverShared(state, event)
    expect(state.deviceRings.byDevice.size).toBe(0)
  })
})

describe('device-event-ring — retained payload cap', () => {
  it('leaves a payload within the cap untouched (identity — no copy, no marker)', () => {
    const event = deviceEvent(42, 'provider.detection', { a: 1 })
    expect(capEventData(event)).toBe(event)
    expect(isTruncatedEventData(event.data)).toBe(false)
  })

  it('replaces an oversized payload with a MARKED truncation carrying its size', () => {
    const big = { blob: 'x'.repeat(4000) }
    const event = deviceEvent(42, 'provider.detection', big)
    const capped = capEventData(event)

    expect(capped).not.toBe(event)
    expect(capped.id).toBe(event.id)
    // The original is never mutated — it is still live on the fan-out path.
    expect(event.data.blob).toBe(big.blob)

    expect(isTruncatedEventData(capped.data)).toBe(true)
    if (!isTruncatedEventData(capped.data)) throw new Error('expected a truncated payload')
    expect(capped.data.__originalBytes).toBeGreaterThan(MAX_RETAINED_DATA_BYTES)
    expect(capped.data.__preview.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(capped.data), 'utf8')).toBeLessThan(
      Buffer.byteLength(JSON.stringify(event.data), 'utf8'),
    )
  })

  it('an unserializable payload is cut and marked, never retained whole', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    const capped = capEventData(deviceEvent(42, 'provider.detection', circular))
    expect(isTruncatedEventData(capped.data)).toBe(true)
  })

  it('the device ring retains the CAPPED event, the global ring the original', () => {
    const state = createSharedBusState(true)
    const event = deviceEvent(42, 'provider.detection', { blob: 'y'.repeat(4000) })
    deliverShared(state, event)

    const retained = getDeviceRecent(state.deviceRings, 42)[0]
    expect(retained).toBeDefined()
    expect(isTruncatedEventData(retained?.data ?? {})).toBe(true)
    expect(state.recent.at(-1)).toBe(event)
  })
})

describe('device-event-ring — non-retaining buses retain nothing', () => {
  it('a child runner / agent bus files no per-device history', () => {
    const state = createSharedBusState()
    for (let i = 0; i < 100; i++) deliverShared(state, deviceEvent(42, 'provider.detection', { i }))
    expect(state.recent.length).toBe(0)
    expect(state.deviceRings.byDevice.size).toBe(0)
  })
})

describe('getRecent — a per-device ask is served from the per-device ring', () => {
  let broker: ServiceBroker | null = null

  afterEach(async () => {
    if (broker) {
      try {
        await broker.stop()
      } catch {
        /* not started */
      }
      broker = null
    }
  })

  it('returns a quiet camera`s history after the fleet displaced it globally', async () => {
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    await broker.start()
    const bus = getBrokerEventBus(broker, { retainRecent: true })

    for (let i = 0; i < 4; i++) bus.emit(deviceEvent(42, 'provider.detection', { i }))
    for (let i = 0; i < MAX_RECENT_EVENTS + 100; i++) {
      bus.emit(deviceEvent(900 + (i % 31), 'provider.detection', { i }))
    }

    // Unscoped read: the quiet camera is gone (global ring, unchanged).
    expect(bus.getRecent().filter((e) => e.source.deviceId === 42).length).toBe(0)
    // Scoped read: all four events, from that device's own ring.
    const scoped = bus.getRecent({ deviceId: 42 })
    expect(scoped.length).toBe(4)
    expect(scoped.every((e) => e.source.deviceId === 42)).toBe(true)
  })

  it('still honours category + limit on the per-device read', async () => {
    broker = new ServiceBroker({ nodeID: 'hub2', transporter: 'Fake', logger: false })
    await broker.start()
    const bus = getBrokerEventBus(broker, { retainRecent: true })

    for (let i = 0; i < 6; i++) bus.emit(deviceEvent(42, 'provider.detection', { i }))
    for (let i = 0; i < 6; i++) bus.emit(deviceEvent(42, 'addon.crashed', { i }))

    expect(bus.getRecent({ deviceId: 42, category: 'provider.detection' }).length).toBe(6)
    expect(bus.getRecent({ deviceId: 42, category: 'addon.crashed' }, 2).length).toBe(2)
    expect(bus.getRecent({ deviceId: 42 }).length).toBe(12)
    // …and a device that never emitted is empty, not someone else's ring.
    expect(bus.getRecent({ deviceId: 43 }).length).toBe(0)
  })

  it('an unscoped ask is still answered from the global ring', async () => {
    broker = new ServiceBroker({ nodeID: 'hub3', transporter: 'Fake', logger: false })
    await broker.start()
    const bus = getBrokerEventBus(broker, { retainRecent: true })
    bus.emit(unattributedEvent('broker.unattributed-sample'))
    expect(bus.getRecent({ category: 'broker.unattributed-sample' }).length).toBe(1)
    // An unattributed event never surfaces under a device scope.
    expect(bus.getRecent({ deviceId: 42, category: 'broker.unattributed-sample' }).length).toBe(0)
  })
})
