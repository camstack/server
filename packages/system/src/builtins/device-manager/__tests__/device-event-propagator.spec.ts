import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeviceEventPropagator } from '../device-event-propagator.js'
import type { IEventBus, SystemEvent, EventFilter, KnownEventCategory } from '@camstack/types'

/**
 * Minimal in-memory event bus stub for propagator tests. Stores every
 * emitted event so assertions can verify the exact shape of each
 * re-emission (source, via[], data). `subscribe({}, ...)` returns an
 * unsubscribe that removes the handler — mirrors the real bus's
 * filter-all behaviour closely enough for the propagator's purposes.
 */
function makeFakeBus() {
  const emitted: SystemEvent[] = []
  const handlers: Array<(ev: SystemEvent) => void> = []

  const bus: IEventBus = {
    emit: ((event: SystemEvent) => {
      emitted.push(event)
      for (const h of handlers) h(event)
    }) as IEventBus['emit'],
    subscribe: ((_filter: EventFilter, handler: (ev: SystemEvent) => void) => {
      handlers.push(handler)
      return () => {
        const i = handlers.indexOf(handler)
        if (i >= 0) handlers.splice(i, 1)
      }
    }) as IEventBus['subscribe'],
    getRecent: () => [] as readonly SystemEvent[],
  } as unknown as IEventBus

  return { bus, emitted }
}

function makeLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
  }
}

function ev(category: string, deviceId: number, data: Record<string, unknown> = {}): SystemEvent {
  return {
    id: `e-${Math.random()}`,
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category,
    data,
  }
}

describe('DeviceEventPropagator', () => {
  let bus: ReturnType<typeof makeFakeBus>['bus']
  let emitted: SystemEvent[]
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    const f = makeFakeBus()
    bus = f.bus
    emitted = f.emitted
    logger = makeLogger()
  })

  it('re-emits a child event on the parent scope with via populated', () => {
    // Topology: 7 → 4 (7 is child of 4, camera 4 has no parent)
    const parents: Record<number, number | null> = { 7: 4, 4: null }
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: (id) => parents[id] ?? null,
      logger,
    })
    p.start()

    bus.emit(ev('doorbell.onPressed', 7, { timestamp: 1000 }))

    // emitted contains: original + 1 re-emission on parent 4
    expect(emitted).toHaveLength(2)
    const reEmission = emitted[1]!
    expect(reEmission.source).toEqual({ type: 'device', id: 4 })
    expect(reEmission.via).toEqual([{ type: 'device', id: 7 }])
    expect(reEmission.category).toBe('doorbell.onPressed')
    expect(reEmission.data).toEqual({ timestamp: 1000 })
  })

  it('walks a multi-level chain (grandchild → parent → grandparent)', () => {
    const parents: Record<number, number | null> = { 7: 4, 4: 1, 1: null }
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: (id) => parents[id] ?? null,
      logger,
    })
    p.start()

    bus.emit(ev('accessory.signal', 7))

    // Original + 2 re-emissions (4 and 1)
    expect(emitted).toHaveLength(3)
    expect(emitted[1]!.source.id).toBe(4)
    expect(emitted[1]!.via).toEqual([{ type: 'device', id: 7 }])
    expect(emitted[2]!.source.id).toBe(1)
    expect(emitted[2]!.via).toEqual([
      { type: 'device', id: 7 },
      { type: 'device', id: 4 },
    ])
  })

  it('does not re-propagate already-propagated events (anti-loop)', () => {
    const parents: Record<number, number | null> = { 7: 4, 4: null }
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: (id) => parents[id] ?? null,
      logger,
    })
    p.start()

    // Emit original — gets ONE re-emission (on 4)
    bus.emit(ev('test.event', 7))
    expect(emitted).toHaveLength(2)

    // Emit an already-propagated event — must NOT be further propagated
    const prev = emitted.length
    bus.emit({
      ...ev('test.event', 4),
      via: [{ type: 'device', id: 7 }],
    } as SystemEvent)
    // One additional emission for the manually-injected event; no further re-emissions
    expect(emitted).toHaveLength(prev + 1)
  })

  it('ignores non-device source scopes', () => {
    const parents: Record<number, number | null> = {}
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: (id) => parents[id] ?? null,
      logger,
    })
    p.start()

    bus.emit({
      id: 'e-1',
      timestamp: new Date(),
      source: { type: 'addon', id: 'recording-engine' },
      category: 'recording.started' as KnownEventCategory,
      data: {},
    })
    expect(emitted).toHaveLength(1) // only the original, no propagation
  })

  it('emits zero re-emissions for standalone devices (no parent)', () => {
    const parents: Record<number, number | null> = { 42: null }
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: (id) => parents[id] ?? null,
      logger,
    })
    p.start()

    bus.emit(ev('test.event', 42))
    expect(emitted).toHaveLength(1)
  })

  it('detects cycles and truncates without infinite loop', () => {
    // Cyclic topology: 1 → 2 → 3 → 1 (corrupt registry)
    const parents: Record<number, number | null> = { 1: 2, 2: 3, 3: 1 }
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: (id) => parents[id] ?? null,
      logger,
    })
    p.start()

    bus.emit(ev('test.event', 1))
    // Chain walks: 1 → 2 → 3 → STOP (next would be 1 again). Three
    // re-emissions: one on 2, one on 3. Plus the original.
    expect(emitted.length).toBeLessThanOrEqual(4)
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.warn.mock.calls[0]![0]).toMatch(/cycle/i)
  })

  it('truncates at MAX_CHAIN_DEPTH on deep chains', () => {
    // Build chain 1 → 2 → 3 → ... → 20 (20 levels)
    const parents: Record<number, number | null> = {}
    for (let i = 1; i < 20; i++) parents[i] = i + 1
    parents[20] = null
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: (id) => parents[id] ?? null,
      logger,
    })
    p.start()

    bus.emit(ev('test.event', 1))
    // Original + at most MAX_CHAIN_DEPTH (16) re-emissions
    expect(emitted.length).toBeLessThanOrEqual(17)
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.warn.mock.calls[0]![0]).toMatch(/depth limit/i)
  })

  it('stop() removes the subscription so further events are not propagated', () => {
    const parents: Record<number, number | null> = { 7: 4, 4: null }
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: (id) => parents[id] ?? null,
      logger,
    })
    p.start()
    bus.emit(ev('test.event', 7))
    expect(emitted).toHaveLength(2) // original + re-emission

    p.stop()
    bus.emit(ev('test.event', 7))
    // +1 original, no re-emission
    expect(emitted).toHaveLength(3)
  })

  it('handles string deviceIds gracefully (coerces or skips)', () => {
    const p = new DeviceEventPropagator({
      eventBus: bus,
      getParentOf: () => null,
      logger,
    })
    p.start()

    bus.emit({
      id: 'e-x',
      timestamp: new Date(),
      source: { type: 'device', id: 'not-a-number' },
      // biome-ignore lint/plugin: synthetic test-only event category
      category: 'something',
      data: {},
    })
    // Only the original, no re-emission
    expect(emitted).toHaveLength(1)
  })
})
