/**
 * Live events subscription — unit + in-process e2e test.
 *
 * Proves that an event emitted on `EventBusService` is delivered to a
 * consumer that went through `live.onEvent` → `iterableSubscription`.
 * This is the same path UI components use via the WS client (AlertBell,
 * EngineTab). If this test passes but the UI still doesn't receive
 * events, the bug is downstream in the WS adapter, not in the routing.
 */
import { describe, it, expect, vi } from 'vitest'
import { SystemEventBus } from '@camstack/system'
import { createLiveEventsRouter } from '../api/core/live-events.router.js'
import { makeCtx } from './cap-routers/harness.js'
import type { EventBusService } from '../core/events/event-bus.service.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeEvent(category: string, data: Record<string, unknown> = {}) {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(),
    source: { type: 'pipeline' as const, id: 'benchmark' },
    category,
    data: { type: `pipeline.${category}`, ...data },
  }
}

describe('live events subscription', () => {
  it('delivers events emitted AFTER subscription', async () => {
    const bus = new SystemEventBus() as unknown as EventBusService
    const router = createLiveEventsRouter(bus, {
      getDeviceRegistry: () => ({ getAll: () => [], getAllForAddon: () => [] }),
    } as never)
    const caller = router.createCaller(makeCtx('admin'))

    const iter = await caller.onEvent({ category: 'benchmark.progress' })

    // Collect received events concurrently while emitting.
    const received: Array<{ category: string; data: Record<string, unknown> }> = []
    const collector = (async () => {
      for await (const ev of iter) {
        received.push({ category: ev.category, data: ev.data })
        if (received.length >= 3) return
      }
    })()

    // Give the async generator a tick to wire up its internal promise.
    await sleep(10)

    bus.emit(makeEvent('benchmark.progress', { iteration: 1, totalMs: 50 }))
    bus.emit(makeEvent('benchmark.progress', { iteration: 2, totalMs: 48 }))
    bus.emit(makeEvent('other.category', { ignored: true }))
    bus.emit(makeEvent('benchmark.progress', { iteration: 3, totalMs: 52 }))

    await collector

    expect(received).toHaveLength(3)
    expect(received.map((r) => r.data.iteration)).toEqual([1, 2, 3])
  })

  it('filters events that do not match the requested category', async () => {
    const bus = new SystemEventBus() as unknown as EventBusService
    const router = createLiveEventsRouter(bus, {
      getDeviceRegistry: () => ({ getAll: () => [], getAllForAddon: () => [] }),
    } as never)
    const caller = router.createCaller(makeCtx('admin'))

    const iter = await caller.onEvent({ category: 'benchmark.progress' })

    const received: string[] = []
    const stop = vi.fn()
    const collector = (async () => {
      for await (const ev of iter) {
        received.push(ev.category)
        if (received.length >= 2) {
          stop()
          return
        }
      }
    })()

    await sleep(10)

    // Emit a mix — only 'benchmark.progress' should pass.
    bus.emit(makeEvent('alert.created', {}))
    bus.emit(makeEvent('benchmark.progress', { iteration: 1 }))
    bus.emit(makeEvent('benchmark.heartbeat', {}))
    bus.emit(makeEvent('alert.updated', {}))
    bus.emit(makeEvent('benchmark.progress', { iteration: 2 }))

    await collector

    expect(received).toEqual(['benchmark.progress', 'benchmark.progress'])
    expect(stop).toHaveBeenCalledOnce()
  })

  it('receives recent events via recentSystemEvents query', async () => {
    const bus = new SystemEventBus() as unknown as EventBusService
    const router = createLiveEventsRouter(bus, {
      getDeviceRegistry: () => ({ getAll: () => [], getAllForAddon: () => [] }),
    } as never)
    const caller = router.createCaller(makeCtx('admin'))

    bus.emit(makeEvent('benchmark.progress', { iteration: 1 }))
    bus.emit(makeEvent('alert.created', {}))
    bus.emit(makeEvent('benchmark.progress', { iteration: 2 }))

    const recent = await caller.recentSystemEvents({ category: 'benchmark.progress', limit: 10 })
    expect(recent).toHaveLength(2)
    // recentSystemEvents returns newest-first
    const iterations = recent.map((e) => e.data.iteration as number).toSorted((a, b) => a - b)
    expect(iterations).toEqual([1, 2])
  })

  it('delivers bursts — multiple events queued before the consumer drains', async () => {
    // Reproduces the benchmark scenario where runBenchmark emits 3 events
    // back-to-back; the subscription should buffer them and deliver all 3.
    const bus = new SystemEventBus() as unknown as EventBusService
    const router = createLiveEventsRouter(bus, {
      getDeviceRegistry: () => ({ getAll: () => [], getAllForAddon: () => [] }),
    } as never)
    const caller = router.createCaller(makeCtx('admin'))

    const iter = await caller.onEvent({ category: 'benchmark.progress' })

    const received: number[] = []
    const collector = (async () => {
      for await (const ev of iter) {
        received.push(ev.data.iteration as number)
        if (received.length >= 5) return
      }
    })()

    // Let the generator body run through its first `await`, registering the
    // bus subscription. Without this tick subscribe() hasn't attached yet.
    await sleep(20)

    // Emit 5 events synchronously — no awaits between.
    for (let i = 1; i <= 5; i++) {
      bus.emit(makeEvent('benchmark.progress', { iteration: i }))
    }

    await collector

    expect(received).toEqual([1, 2, 3, 4, 5])
  })
})
