/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test file: fake broker + wire-boundary casts */
import type { SystemEvent } from '@camstack/types'
import type { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import { crossNodeAcceptsCategory } from '../../moleculer/event-bus-core.js'
import {
  createBrokerEventBus,
  EVENT_TOPIC_PREFIX,
  getBrokerEventBus,
  getMoleculerEventStats,
  setNodeEventInterest,
  subscribePassthrough,
} from '../../moleculer/event-bus.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import type { LocalChannel, LocalTransportClient } from '../../transport/local-transport.js'
import type { ParentEventMessage } from '../../transport/child-cap-protocol.js'
import { EventCategory } from '@camstack/types'

const EVENT_TOPIC_WILDCARD = `${EVENT_TOPIC_PREFIX}**`

// ---------------------------------------------------------------------------
// crossNodeAcceptsCategory — the pure receiving-side gate
// ---------------------------------------------------------------------------

describe('crossNodeAcceptsCategory (pure gate)', () => {
  it('a subscribed category passes, an unsubscribed one is dropped', () => {
    const snap = { retainRecent: false, interest: ['pipeline.*', 'device.online'] }
    expect(crossNodeAcceptsCategory(snap, 'pipeline.trace')).toBe(true)
    expect(crossNodeAcceptsCategory(snap, 'device.online')).toBe(true)
    expect(crossNodeAcceptsCategory(snap, 'metrics.node-resources-snapshot')).toBe(false)
  })

  it('fail-open: undeclared interest (null) accepts every category', () => {
    const snap = { retainRecent: false, interest: null }
    expect(crossNodeAcceptsCategory(snap, 'anything.at.all')).toBe(true)
  })

  it('a retaining bus (hub main) accepts every category regardless of interest', () => {
    const snap = { retainRecent: true, interest: ['device.*'] }
    expect(crossNodeAcceptsCategory(snap, 'pipeline.trace')).toBe(true)
  })

  it('an empty interest set (node with no interested children) drops everything', () => {
    const snap = { retainRecent: false, interest: [] as string[] }
    expect(crossNodeAcceptsCategory(snap, 'device.online')).toBe(false)
  })

  it('wildcard patterns match with the same semantics as matchesPattern', () => {
    const snap = { retainRecent: false, interest: ['pipeline.**'] }
    expect(crossNodeAcceptsCategory(snap, 'pipeline.deep.trace')).toBe(true)
    expect(crossNodeAcceptsCategory(snap, 'device.online')).toBe(false)
    const star = { retainRecent: false, interest: ['*'] }
    expect(crossNodeAcceptsCategory(star, 'device.online')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// $event-bus inbound handler gate — integration via a fake broker
// ---------------------------------------------------------------------------

function evt(
  category: string,
  sourceNodeId = 'agent-remote',
): SystemEvent & { sourceNodeId: string } {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    source: { type: 'core', id: 'agent-remote' },
    category,
    data: {},
    sourceNodeId,
  }
}

/**
 * A fake Moleculer broker that captures the `$event-bus` wildcard handler
 * registered by `registerEventBusService` so a test can feed it inbound
 * cross-node events without a real cluster. The object is a valid WeakMap
 * key so the per-broker shared bus / interest oracle / stats all resolve.
 */
function makeInboundHarness(nodeID: string, opts?: { retainRecent?: boolean }) {
  let evtHandler: ((ctx: { params: unknown }) => void) | null = null
  const broker = {
    nodeID,
    createService(schema: { events?: Record<string, (ctx: { params: unknown }) => void> }) {
      const h = schema.events?.[EVENT_TOPIC_WILDCARD]
      if (h) evtHandler = h
    },
    broadcast() {},
    localBus: { on() {} },
    logger: { warn() {} },
    call: async () => undefined,
    waitForServices: async () => undefined,
  }
  const service = broker as unknown as ServiceBroker
  // getBrokerEventBus → registerEventBusService → createService (captures handler).
  const bus = getBrokerEventBus(service, opts)
  const delivered: string[] = []
  // Record deliveries via a PASS-THROUGH subscription so this test observer does
  // NOT register as local interest (a counted `*` sub would make the gate accept
  // everything and mask the filter). Mirrors how the UDS bridge relays.
  subscribePassthrough(service, (e) => delivered.push(e.category))
  return {
    broker: service,
    bus,
    delivered,
    inbound: (event: SystemEvent & { sourceNodeId: string }) => evtHandler?.({ params: event }),
  }
}

describe('$event-bus inbound cross-node gate', () => {
  it('only categories the node is interested in are delivered locally', () => {
    const h = makeInboundHarness('agent-a')
    setNodeEventInterest(h.broker, () => ['pipeline.*'])

    h.inbound(evt('pipeline.trace')) // wanted
    h.inbound(evt('metrics.node-resources-snapshot')) // not wanted

    expect(h.delivered).toEqual(['pipeline.trace'])
    const stats = getMoleculerEventStats(h.broker)
    expect(stats).toEqual({ delivered: 1, suppressed: 1 })
  })

  it('fail-open: no interest oracle installed → every category is delivered', () => {
    const h = makeInboundHarness('agent-nooracle')

    h.inbound(evt('pipeline.trace'))
    h.inbound(evt('device.online'))

    expect(h.delivered).toEqual(['pipeline.trace', 'device.online'])
    expect(getMoleculerEventStats(h.broker)).toEqual({ delivered: 2, suppressed: 0 })
  })

  it('fail-open: an oracle returning null (undeclared child) delivers everything', () => {
    const h = makeInboundHarness('agent-undeclared')
    setNodeEventInterest(h.broker, () => null)

    h.inbound(evt('anything.here'))
    expect(h.delivered).toEqual(['anything.here'])
  })

  it('retaining bus (hub main) delivers every category despite a narrow oracle', () => {
    const h = makeInboundHarness('hub', { retainRecent: true })
    setNodeEventInterest(h.broker, () => ['device.*'])

    h.inbound(evt('pipeline.trace')) // not in interest, but hub retains everything
    expect(h.delivered).toEqual(['pipeline.trace'])
  })

  it('self-origin echoes are dropped before the gate (no double-count)', () => {
    const h = makeInboundHarness('agent-self')
    setNodeEventInterest(h.broker, () => ['pipeline.*'])

    h.inbound(evt('pipeline.trace', 'agent-self')) // own broadcast echo
    expect(h.delivered).toEqual([])
    // Echo is dropped before the gate runs, so it is not counted either way.
    expect(getMoleculerEventStats(h.broker)).toBeNull()
  })

  it('setNodeEventInterest(broker, null) clears the oracle → fail-open', () => {
    const h = makeInboundHarness('agent-clear')
    setNodeEventInterest(h.broker, () => ['pipeline.*'])
    setNodeEventInterest(h.broker, null)

    h.inbound(evt('device.online'))
    expect(h.delivered).toEqual(['device.online'])
  })

  it('an oracle that throws fails OPEN (delivers) and does not break the handler', () => {
    const h = makeInboundHarness('agent-throw')
    setNodeEventInterest(h.broker, () => {
      throw new Error('oracle boom')
    })

    expect(() => h.inbound(evt('device.online'))).not.toThrow()
    expect(h.delivered).toEqual(['device.online'])
  })
})

// ---------------------------------------------------------------------------
// CRITICAL regression: in-process ('broker'-mode) subscribers must NOT be
// starved by the filter, even when the only forked children want other
// categories. Wires the gate exactly as production (setNodeEventInterest from a
// live LocalChildRegistry + subscribePassthrough bridge relay).
// ---------------------------------------------------------------------------

const nid = () => `xn-test-${process.pid}-${Math.random().toString(36).slice(2)}`
const flush = () => new Promise((r) => setTimeout(r, 20))

/** Connect a fake UDS child that registers with a fixed eventPatterns set. */
async function connectChild(
  nodeId: string,
  childId: string,
  eventPatterns: readonly string[],
): Promise<{ client: LocalTransportClient; channel: LocalChannel }> {
  const client = createLocalTransport().createClient(nodeId)
  const channel = await client.connect()
  channel.onRequest(async () => 'ok')
  channel.onEvent((body) => {
    void (body as ParentEventMessage)
  })
  await channel.request({
    kind: 'register',
    childId,
    caps: [{ capName: 'noop', mode: 'singleton' }],
    eventPatterns,
  })
  return { client, channel }
}

describe('$event-bus inbound gate — in-process subscriber protection (CRITICAL)', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  it('an in-process addon subscriber STILL receives its category when the only forked child wants a disjoint set', async () => {
    const h = makeInboundHarness('agent-inproc')

    // A forked child that wants ONLY pipeline.* (disjoint from the in-process
    // subscriber's category). This is what the oracle sees.
    const udsNode = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(udsNode))
    await registry.start()
    const child = await connectChild(udsNode, 'pipeline-runner', ['pipeline.*'])
    clients.push(child.client)
    await flush()

    // Wire the gate exactly as production: oracle = forked-child aggregate.
    setNodeEventInterest(h.broker, () => registry!.aggregateEventInterest())

    // An in-process ('broker'-mode) addon subscribes to device.bindings-changed
    // via the SAME path createAddonContext uses (createBrokerEventBus → subscribe
    // → getBrokerEventBus(broker).subscribe). This is the binding-cache
    // invalidation subscription every addon context registers.
    const addonBus = createBrokerEventBus(h.broker, 'core-device-manager')
    const received: string[] = []
    addonBus.subscribe({ category: EventCategory.DeviceBindingsChanged }, (e) =>
      received.push(e.category),
    )

    // Feed an inbound cross-node device.bindings-changed event.
    h.inbound(evt(EventCategory.DeviceBindingsChanged))
    // And a disjoint category the child DOES want (sanity: still flows).
    h.inbound(evt('pipeline.trace'))
    await flush()

    // CRITICAL: the in-process subscriber must have received bindings-changed
    // even though NO forked child declared it. (RED before the local-interest
    // union fix: this array was empty.)
    expect(received).toEqual([EventCategory.DeviceBindingsChanged])
    // The child's category still passes too (both are in the combined interest).
    expect(h.delivered).toEqual([EventCategory.DeviceBindingsChanged, 'pipeline.trace'])
  })

  it('boot window: no forked child connected yet → inbound events still delivered (fail-open via null)', async () => {
    const h = makeInboundHarness('agent-boot')

    const udsNode = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(udsNode))
    await registry.start()
    // No child connects. aggregateEventInterest() must be null → fail-open.
    setNodeEventInterest(h.broker, () => registry!.aggregateEventInterest())

    h.inbound(evt('device.online'))
    h.inbound(evt('metrics.node-resources-snapshot'))
    await flush()

    expect(h.delivered).toEqual(['device.online', 'metrics.node-resources-snapshot'])
  })
})
