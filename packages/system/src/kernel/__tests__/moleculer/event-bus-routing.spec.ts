/**
 * Event-bus routing test for the post-D8 unified bus.
 *
 * Three layers:
 *   1. Intra-broker — two `getBrokerEventBus(broker)` views share state.
 *      One emit, every subscriber on the same broker fires exactly once.
 *      No echo from `$event-bus` (own-broker filter via sourceNodeId).
 *
 *   2. Cross-broker (FakeTransporter) — broker A emits, broker B's
 *      subscriber fires. Verifies the `$event-bus` service broadcast ↔
 *      shared bus path. Same broker still fires once.
 *
 *   3. Pattern matching — wildcard subscribers receive every event,
 *      exact-category subscribers only their own.
 */

import type { SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { ServiceBroker } from 'moleculer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getBrokerEventBus, registerEventBusService } from '../../moleculer/event-bus.js'

function makeEvent(
  category: EventCategory | string,
  data: Record<string, unknown> = {},
): SystemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    category: category as EventCategory,
    timestamp: new Date(),
    source: { type: 'addon', id: 'test-addon', nodeId: 'test-node' },
    data,
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — intra-broker (single ServiceBroker, multiple bus views)
// ---------------------------------------------------------------------------

describe('event-bus intra-broker routing', { timeout: 10_000 }, () => {
  const broker = new ServiceBroker({
    nodeID: 'test-intra',
    transporter: 'Fake',
    logger: false,
  })

  beforeAll(async () => {
    registerEventBusService(broker)
    await broker.start()
  })

  afterAll(async () => {
    await broker.stop()
  })

  it('two bus views on same broker share state — emit on A, B receives once', () => {
    const busA = getBrokerEventBus(broker)
    const busB = getBrokerEventBus(broker)

    const received: SystemEvent[] = []
    const unsub = busB.subscribe({ category: 'addon.started' }, (e) => received.push(e))

    busA.emit(makeEvent('addon.started', { addonId: 'foo' }))

    expect(received).toHaveLength(1)
    expect(received[0]?.data).toEqual({ addonId: 'foo' })
    unsub()
  })

  it('emit fires the same-broker subscriber exactly once (no broadcast echo)', async () => {
    const bus = getBrokerEventBus(broker)
    let count = 0
    const unsub = bus.subscribe({ category: 'camera.connected' }, () => {
      count++
    })

    bus.emit(makeEvent('camera.connected', { deviceId: 1 }))

    // Wait long enough for any potential broadcast loopback to land.
    await new Promise((r) => setTimeout(r, 50))
    expect(count).toBe(1)
    unsub()
  })

  it('wildcard pattern matches every category', () => {
    const bus = getBrokerEventBus(broker)
    const seen: string[] = []
    const unsub = bus.subscribe({ category: '*' }, (e) => seen.push(e.category))

    bus.emit(makeEvent('addon.error'))
    bus.emit(makeEvent('camera.disconnected'))

    expect(seen).toContain('addon.error')
    expect(seen).toContain('camera.disconnected')
    unsub()
  })

  it('exact-category subscriber ignores other categories', () => {
    const bus = getBrokerEventBus(broker)
    const seen: string[] = []
    const unsub = bus.subscribe({ category: 'motion.detected' }, (e) => seen.push(e.category))

    bus.emit(makeEvent('motion.detected'))
    bus.emit(makeEvent('addon.started'))

    expect(seen).toEqual(['motion.detected'])
    unsub()
  })

  it('unsubscribe stops delivery', () => {
    const bus = getBrokerEventBus(broker)
    let count = 0
    const unsub = bus.subscribe({ category: 'addon.stopped' }, () => {
      count++
    })

    bus.emit(makeEvent('addon.stopped'))
    expect(count).toBe(1)

    unsub()
    bus.emit(makeEvent('addon.stopped'))
    expect(count).toBe(1)
  })

  it('getRecent returns events in emit order, filtered by category (retaining/hub-main bus)', () => {
    // Retention is opt-in and hub-main only — pass retainRecent to exercise it.
    const bus = getBrokerEventBus(broker, { retainRecent: true })

    bus.emit(makeEvent('test.recent.A', { i: 1 }))
    bus.emit(makeEvent('test.recent.B', { i: 2 }))
    bus.emit(makeEvent('test.recent.A', { i: 3 }))

    const onlyA = bus.getRecent({ category: 'test.recent.A' as EventCategory })
    expect(onlyA.map((e) => e.data['i'])).toEqual([1, 3])
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — cross-broker (two brokers on a Fake transporter)
// ---------------------------------------------------------------------------

describe('event-bus cross-broker routing', { timeout: 30_000 }, () => {
  // TCP transit on random ports — Fake transporter is per-broker
  // (each broker has its own in-memory bus, no cross-broker delivery).
  const brokerA = new ServiceBroker({
    nodeID: 'cross-a',
    transporter: { type: 'TCP', options: { udpDiscovery: false, port: 0 } },
    logger: false,
  })
  const brokerB = new ServiceBroker({
    nodeID: 'cross-b',
    transporter: { type: 'TCP', options: { udpDiscovery: false, port: 0 } },
    logger: false,
  })

  beforeAll(async () => {
    registerEventBusService(brokerA)
    registerEventBusService(brokerB)
    await brokerA.start()
    const portA =
      (brokerA as unknown as { transit: { tx: { opts?: { port?: number } } } }).transit.tx.opts
        ?.port ?? 0
    if (!portA) throw new Error('broker A failed to bind a TCP port')
    // Configure broker B to connect to broker A via static URL
    const txB = (brokerB as unknown as { transit: { tx: { opts: { urls: string[] } } } }).transit.tx
    txB.opts.urls = [`tcp://127.0.0.1:${portA}/cross-a`]
    await brokerB.start()
    // Wait until both brokers see each other in the registry.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('cross-broker discovery did not converge in 10s')),
        10_000,
      )
      const tick = setInterval(() => {
        const aSeesB = (
          brokerA as unknown as {
            registry: { nodes: { list: (o: Record<string, boolean>) => Array<{ id: string }> } }
          }
        ).registry.nodes
          .list({ onlyAvailable: true })
          .some((n) => n.id === 'cross-b')
        const bSeesA = (
          brokerB as unknown as {
            registry: { nodes: { list: (o: Record<string, boolean>) => Array<{ id: string }> } }
          }
        ).registry.nodes
          .list({ onlyAvailable: true })
          .some((n) => n.id === 'cross-a')
        if (aSeesB && bSeesA) {
          clearInterval(tick)
          clearTimeout(deadline)
          resolve()
        }
      }, 100)
    })
  })

  afterAll(async () => {
    await Promise.all([brokerA.stop(), brokerB.stop()])
  })

  it('emit on broker A delivers to broker B subscriber via $event-bus', async () => {
    const busA = getBrokerEventBus(brokerA)
    const busB = getBrokerEventBus(brokerB)

    const received: SystemEvent[] = []
    busB.subscribe({ category: 'cross.test' }, (e) => received.push(e))

    busA.emit(makeEvent('cross.test', { who: 'A' }))

    // Allow the broadcast roundtrip to land on B.
    await new Promise((r) => setTimeout(r, 200))

    expect(received).toHaveLength(1)
    expect(received[0]?.data['who']).toBe('A')
  })

  it('A emits — A subscriber fires once, no double-delivery from broadcast echo', async () => {
    const busA = getBrokerEventBus(brokerA)
    let aCount = 0
    busA.subscribe({ category: 'echo.test' }, () => {
      aCount++
    })

    busA.emit(makeEvent('echo.test'))

    // Generous window for the loopback broadcast we're trying to NOT
    // double-fire from. If the echo were broken, aCount would tick to 2
    // by the time this resolves.
    await new Promise((r) => setTimeout(r, 200))
    expect(aCount).toBe(1)
  })

  it('B emits, A receives, B sees own emit exactly once', async () => {
    const busA = getBrokerEventBus(brokerA)
    const busB = getBrokerEventBus(brokerB)

    let aCount = 0
    let bCount = 0
    busA.subscribe({ category: 'reverse.test' }, () => {
      aCount++
    })
    busB.subscribe({ category: 'reverse.test' }, () => {
      bCount++
    })

    busB.emit(makeEvent('reverse.test'))
    await new Promise((r) => setTimeout(r, 200))

    expect(bCount).toBe(1)
    expect(aCount).toBe(1)
  })

  it('emits one Moleculer event per category under the camstack.evt.* namespace', async () => {
    registerEventBusService(brokerA)
    registerEventBusService(brokerB)
    const seen: string[] = []
    const origBroadcast = brokerA.broadcast.bind(brokerA)
    brokerA.broadcast = ((name: string, payload: unknown) => {
      seen.push(name)
      return origBroadcast(name, payload)
    }) as typeof brokerA.broadcast

    const bus = getBrokerEventBus(brokerA)
    bus.emit({
      id: 'e1',
      timestamp: new Date(),
      source: { type: 'test', id: 't' },
      category: EventCategory.PipelineProgress,
      data: {},
    })

    expect(seen).toContain('camstack.evt.pipeline.progress')
    expect(seen).not.toContain('camstack.cluster.event')
  })
})
