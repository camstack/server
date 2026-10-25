/**
 * Unit tests for `createUdsEventBridge` (C2 — parent-side UDS↔Moleculer event bridge).
 *
 * Uses fakes for both `LocalChildRegistry` (child event interface) and the
 * parent's `IEventBus` — no real UDS sockets, no Moleculer broker.
 *
 * Coverage goals:
 *   1. child→out: a child event is (a) delivered to the parent bus, AND
 *      (b) fanned to siblings via broadcastEventToChildren (excluding origin).
 *      The origin child does NOT receive the event back.
 *   2. inbound echo-prevention: an event that ORIGINATED from one of THIS
 *      parent's children (already fanned in step 1) is NOT re-fanned to
 *      children by the parent-bus subscriber — no double-fan, no bounce.
 *   3. cluster/parent-local→children: an event R that did NOT originate
 *      from a child IS fanned to ALL children via broadcastEventToChildren.
 *   4. exactly-once: no event is delivered to any given child more than once
 *      across the two paths.
 *   5. dispose: calling the returned disposer stops all handlers.
 *   6. cross-node regression: an event arriving on the parent bus from a
 *      REMOTE node (id never seen by onChildEvent) IS fanned to local children.
 *      This guards against the prior __udsChildOriginId marker approach, which
 *      caused remote bridges to wrongly skip fanning clean events.
 */

import type { EventFilter, IEventBus, SystemEvent } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubscriberEntry } from '../../moleculer/event-bus-core.js'
import {
  createSharedBusState,
  deliverShared,
  extractCategoryPattern,
} from '../../moleculer/event-bus-core.js'
import type { ParentEventMessage } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import type { UdsEventBridgeDeps } from '../../transport/uds-event-bridge.js'
import { createUdsEventBridge } from '../../transport/uds-event-bridge.js'
import { createUdsEventBus } from '../../transport/uds-event-bus.js'

// ---------------------------------------------------------------------------
// Fake LocalChildRegistry surface
// ---------------------------------------------------------------------------

type ChildEventHandler = ((childId: string, event: SystemEvent) => void) | null

interface FakeRegistry {
  readonly onChildEvent: (handler: ChildEventHandler) => void
  readonly sendEventToChild: ReturnType<
    typeof vi.fn<(childId: string, event: SystemEvent, sourceNodeId: string) => void>
  >
  readonly broadcastEventToChildren: ReturnType<
    typeof vi.fn<(event: SystemEvent, sourceNodeId: string, exceptChildId?: string) => void>
  >
  /** Simulate a child emitting an event by calling the registered handler. */
  triggerChildEvent(childId: string, event: SystemEvent): void
}

function makeFakeRegistry(): FakeRegistry {
  let capturedHandler: ChildEventHandler = null
  const sendEventToChild =
    vi.fn<(childId: string, event: SystemEvent, sourceNodeId: string) => void>()
  const broadcastEventToChildren =
    vi.fn<(event: SystemEvent, sourceNodeId: string, exceptChildId?: string) => void>()

  return {
    onChildEvent(handler: ChildEventHandler): void {
      capturedHandler = handler
    },
    sendEventToChild,
    broadcastEventToChildren,
    triggerChildEvent(childId: string, event: SystemEvent): void {
      if (capturedHandler === null) {
        throw new Error('No onChildEvent handler registered — call createUdsEventBridge first')
      }
      capturedHandler(childId, event)
    },
  }
}

// ---------------------------------------------------------------------------
// Fake IEventBus
// ---------------------------------------------------------------------------

type BusSubscribeHandler = (event: SystemEvent) => void

interface FakeBus {
  readonly emit: ReturnType<typeof vi.fn<(event: SystemEvent) => void>>
  /** Simulate an incoming event (e.g. from cluster or parent-local). */
  triggerSubscribers(event: SystemEvent): void
  bus: IEventBus
}

function makeFakeBus(): FakeBus {
  const emitFn = vi.fn<(event: SystemEvent) => void>()
  const subscribers = new Set<BusSubscribeHandler>()

  const bus: IEventBus = {
    emit: emitFn,
    subscribe(_filter: EventFilter | string, handler: BusSubscribeHandler): () => void {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },
    getRecent(): readonly SystemEvent[] {
      return []
    },
  }

  return {
    emit: emitFn,
    triggerSubscribers(event: SystemEvent): void {
      for (const handler of subscribers) {
        handler(event)
      }
    },
    bus,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(category: string, extra?: Partial<SystemEvent>): SystemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    source: { type: 'addon', id: 'test-addon' },
    category,
    data: {},
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createUdsEventBridge', () => {
  const parentNodeId = 'hub'
  let registry: FakeRegistry
  let fakeBus: FakeBus
  let deps: UdsEventBridgeDeps

  beforeEach(() => {
    registry = makeFakeRegistry()
    fakeBus = makeFakeBus()
    deps = {
      registry: {
        onChildEvent: registry.onChildEvent.bind(registry),
        sendEventToChild: registry.sendEventToChild,
        broadcastEventToChildren: registry.broadcastEventToChildren,
      },
      parentBus: fakeBus.bus,
      parentNodeId,
    }
  })

  // ── 1. child→out ─────────────────────────────────────────────────────────

  it('child event is pushed to the parent bus', () => {
    createUdsEventBridge(deps)
    const evt = makeEvent('addon.started')

    registry.triggerChildEvent('childA', evt)

    expect(fakeBus.emit).toHaveBeenCalledOnce()
    const emitted = fakeBus.emit.mock.calls[0]![0]
    expect(emitted.id).toBe(evt.id)
  })

  it('child event emitted to parent bus is the clean (unmodified) event', () => {
    createUdsEventBridge(deps)
    const evt = makeEvent('addon.started')

    registry.triggerChildEvent('childA', evt)

    const emitted = fakeBus.emit.mock.calls[0]![0]!
    // The cluster broadcast must NOT carry any extra marker fields — only
    // the standard SystemEvent properties should be present.
    expect(Object.keys(emitted)).toEqual(
      expect.arrayContaining(['id', 'timestamp', 'source', 'category', 'data']),
    )
    // Specifically: no __udsChildOriginId marker
    expect(Object.prototype.hasOwnProperty.call(emitted, '__udsChildOriginId')).toBe(false)
  })

  it('child event is fanned to siblings (broadcastEventToChildren called with exceptChildId)', () => {
    createUdsEventBridge(deps)
    const evt = makeEvent('addon.started')

    registry.triggerChildEvent('childA', evt)

    expect(registry.broadcastEventToChildren).toHaveBeenCalledOnce()
    const [broadcastEvt, sourceNodeId, exceptChildId] =
      registry.broadcastEventToChildren.mock.calls[0]!
    expect(broadcastEvt.id).toBe(evt.id)
    expect(sourceNodeId).toBe(parentNodeId)
    expect(exceptChildId).toBe('childA')
  })

  it('child origin does NOT receive the event via sendEventToChild', () => {
    createUdsEventBridge(deps)
    const evt = makeEvent('addon.started')

    registry.triggerChildEvent('childA', evt)

    // sendEventToChild should never be called for the originating child
    expect(registry.sendEventToChild).not.toHaveBeenCalledWith(
      'childA',
      expect.anything(),
      expect.anything(),
    )
  })

  // ── 2. inbound echo-prevention — no double-fan ────────────────────────────

  it('a child-origin event arriving on the parent bus does NOT trigger a second broadcastEventToChildren', () => {
    createUdsEventBridge(deps)
    const evt = makeEvent('addon.started')

    // Simulate child→parent: triggers broadcastEventToChildren ONCE and emits to parent bus.
    registry.triggerChildEvent('childA', evt)

    // The parentBus.emit was called — now simulate the parentBus notifying its own subscribers.
    // The bridge subscribed to the parent bus; it should NOT re-fan this event because
    // its id is already in recentlyFannedIds (id-dedupe set).
    //
    // Capture the event that was emitted to the parent bus (same clean event).
    const emittedEvt = fakeBus.emit.mock.calls[0]![0]!

    // Reset the mock to count calls from the subscriber path cleanly.
    registry.broadcastEventToChildren.mockClear()

    // Trigger the parent bus subscriber with the same event (simulating the bus loop-back).
    fakeBus.triggerSubscribers(emittedEvt)

    // The bridge must NOT fan-out again (the id-dedupe set blocks it).
    expect(registry.broadcastEventToChildren).not.toHaveBeenCalled()
  })

  it('a child-origin event does not reach ANY child a second time through the bus subscriber path', () => {
    createUdsEventBridge(deps)
    const evt = makeEvent('device.online')

    registry.triggerChildEvent('childB', evt)

    const emittedEvt = fakeBus.emit.mock.calls[0]![0]!
    // clear both mocks
    registry.broadcastEventToChildren.mockClear()
    registry.sendEventToChild.mockClear()

    fakeBus.triggerSubscribers(emittedEvt)

    expect(registry.broadcastEventToChildren).not.toHaveBeenCalled()
    expect(registry.sendEventToChild).not.toHaveBeenCalled()
  })

  // ── 3. cluster/parent-local→children ──────────────────────────────────────

  it('a non-child-origin event on the parent bus IS fanned to all children', () => {
    createUdsEventBridge(deps)

    // Simulate a remote cluster event arriving on the parent bus — not from a child.
    const clusterEvt = makeEvent('agent.online', {
      id: 'cluster-evt-1',
      source: { type: 'core', id: 'hub', nodeId: 'hub' },
    })

    fakeBus.triggerSubscribers(clusterEvt)

    expect(registry.broadcastEventToChildren).toHaveBeenCalledOnce()
    const [broadcastEvt, sourceNodeId, exceptChildId] =
      registry.broadcastEventToChildren.mock.calls[0]!
    expect(broadcastEvt.id).toBe(clusterEvt.id)
    expect(sourceNodeId).toBe(parentNodeId)
    // No child to exclude — undefined means all children receive it
    expect(exceptChildId).toBeUndefined()
  })

  it('a parent-process-local emit is fanned to children exactly once', () => {
    createUdsEventBridge(deps)

    const parentLocalEvt = makeEvent('addon.stopped', {
      id: 'local-evt-1',
    })

    // Simulate an event emitted from within the parent process itself (not via child).
    fakeBus.triggerSubscribers(parentLocalEvt)

    expect(registry.broadcastEventToChildren).toHaveBeenCalledTimes(1)
  })

  // ── 4. exactly-once ───────────────────────────────────────────────────────

  it('a child event is delivered to the parent bus exactly once, not twice', () => {
    createUdsEventBridge(deps)
    const evt = makeEvent('device.online')

    registry.triggerChildEvent('childA', evt)

    // parent bus emit is called once (from the child→parent forwarding path)
    expect(fakeBus.emit).toHaveBeenCalledTimes(1)
  })

  it('siblings are broadcast exactly once per child event', () => {
    createUdsEventBridge(deps)
    const evt = makeEvent('addon.started')

    registry.triggerChildEvent('childC', evt)
    // Simulate the parent bus notifying subscribers with the same event id
    const emittedEvt = fakeBus.emit.mock.calls[0]![0]!
    fakeBus.triggerSubscribers(emittedEvt)

    // broadcastEventToChildren should only be called once (from the child-origin path)
    expect(registry.broadcastEventToChildren).toHaveBeenCalledTimes(1)
  })

  // ── 5. dispose ───────────────────────────────────────────────────────────

  it('dispose stops the parent bus subscriber from fanning events to children', () => {
    const dispose = createUdsEventBridge(deps)
    dispose()

    const evt = makeEvent('agent.online')
    fakeBus.triggerSubscribers(evt)

    expect(registry.broadcastEventToChildren).not.toHaveBeenCalled()
  })

  it('dispose clears the child-event handler (null passed to onChildEvent)', () => {
    // Track what was passed to onChildEvent across both calls
    const calls: Array<((childId: string, event: SystemEvent) => void) | null> = []
    const trackingRegistry = {
      onChildEvent(handler: ((childId: string, event: SystemEvent) => void) | null): void {
        calls.push(handler)
      },
      sendEventToChild:
        vi.fn<(childId: string, event: SystemEvent, sourceNodeId: string) => void>(),
      broadcastEventToChildren:
        vi.fn<(event: SystemEvent, sourceNodeId: string, exceptChildId?: string) => void>(),
    }
    const dispose = createUdsEventBridge({ ...deps, registry: trackingRegistry })
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toBeNull()

    dispose()

    // After dispose, onChildEvent should have been called with null to clear the handler
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBeNull()
  })

  // ── 6. cross-node regression ─────────────────────────────────────────────
  //
  // Guard against the prior __udsChildOriginId marker approach:
  // a clean event arriving from a REMOTE node (whose id was never passed
  // through onChildEvent on THIS bridge) MUST be fanned to local children.
  // If the bridge wrongly skipped it (e.g. marker on the wire), this test fails.

  it('an event from a remote node (id not in recentlyFannedIds) IS fanned to local children', () => {
    createUdsEventBridge(deps)

    // This event was NOT produced by any of this bridge's onChildEvent calls.
    // It simulates an event that arrived on the parent bus from a remote node
    // in the cluster (e.g. hub's event bridge fanned a hub-child event to the
    // cluster; agent-0's parent bus receives it via the $event-bus Moleculer service).
    const remoteEvent = makeEvent('device.online', {
      id: 'remote-hub-child-evt-99',
      source: { type: 'addon', id: 'reolink-provider', nodeId: 'hub' },
    })

    // No call to registry.triggerChildEvent — the id is NOT in recentlyFannedIds.
    fakeBus.triggerSubscribers(remoteEvent)

    // The bridge MUST fan the remote event to this node's local UDS children.
    expect(registry.broadcastEventToChildren).toHaveBeenCalledOnce()
    const [broadcastEvt, , exceptChildId] = registry.broadcastEventToChildren.mock.calls[0]!
    expect(broadcastEvt.id).toBe(remoteEvent.id)
    expect(exceptChildId).toBeUndefined()
  })

  it('a local child event does not suppress a later remote event with the same category but different id', () => {
    createUdsEventBridge(deps)

    // Local child emits event A
    const childEvt = makeEvent('device.online', { id: 'local-child-evt-A' })
    registry.triggerChildEvent('childA', childEvt)
    registry.broadcastEventToChildren.mockClear()

    // A different remote event with the same category but a DIFFERENT id arrives.
    const remoteEvt = makeEvent('device.online', { id: 'remote-evt-B' })
    fakeBus.triggerSubscribers(remoteEvt)

    // The remote event must be fanned — it has a different id so it was NOT suppressed.
    expect(registry.broadcastEventToChildren).toHaveBeenCalledOnce()
    const [broadcastEvt] = registry.broadcastEventToChildren.mock.calls[0]!
    expect(broadcastEvt.id).toBe(remoteEvt.id)
  })
})

// ---------------------------------------------------------------------------
// Real-bus regression: match-all filter actually matches at runtime
// ---------------------------------------------------------------------------
//
// The fake-bus tests above never exercise real category matching — the fake
// subscribe() ignores the filter and calls every subscriber unconditionally.
// This suite wires the bridge against a REAL IEventBus built from the
// event-bus-core primitives (createSharedBusState + deliverShared + the same
// subscribe logic used by event-bus.ts) so that `matchesPattern` and
// `matchesEventFilter` execute for every emit.  It proves that the `{}`
// match-all EventFilter reaches the bridge subscriber for:
//   (a) `system.ready-state` — the readiness-delta category (Phase D)
//   (b) an arbitrary non-catalog category — forward-compat guard

function makeRealEventBus(): IEventBus {
  const state = createSharedBusState()

  const bus: IEventBus = {
    emit(event: SystemEvent): void {
      deliverShared(state, event)
    },
    subscribe(filter: EventFilter | string, handler: (event: SystemEvent) => void): () => void {
      const pattern = extractCategoryPattern(filter as EventFilter | string)
      const entry: SubscriberEntry = {
        filter: filter as EventFilter | string | undefined,
        categoryPattern: pattern,
        handler,
      }
      const set = state.handlers.get(pattern) ?? new Set<SubscriberEntry>()
      set.add(entry)
      state.handlers.set(pattern, set)
      return (): void => {
        state.handlers.get(pattern)?.delete(entry)
      }
    },
    getRecent(): readonly SystemEvent[] {
      return state.recent
    },
  }

  return bus
}

describe('createUdsEventBridge — real-bus match-all filter regression', () => {
  it('the {} match-all filter reaches the bridge subscriber for system.ready-state events', () => {
    const realBus = makeRealEventBus()
    const broadcastEventToChildren =
      vi.fn<(event: SystemEvent, sourceNodeId: string, exceptChildId?: string) => void>()
    const bridgeDeps: UdsEventBridgeDeps = {
      registry: {
        onChildEvent: vi.fn(),
        sendEventToChild: vi.fn(),
        broadcastEventToChildren,
      },
      parentBus: realBus,
      parentNodeId: 'hub',
    }

    createUdsEventBridge(bridgeDeps)

    // Emit a system.ready-state event directly on the real bus (not via child path).
    const readyEvt: SystemEvent = {
      id: 'ready-evt-1',
      timestamp: new Date(),
      source: { type: 'capability', id: 'stream-broker', nodeId: 'hub' },
      category: 'system.ready-state',
      data: {
        capName: 'stream-broker',
        scope: { type: 'global' },
        state: 'ready',
        generation: 'gen-1',
        sourceNodeId: 'hub',
        ts: Date.now(),
      },
    }

    realBus.emit(readyEvt)

    // The bridge must have fanned the event to children — proves match-all matched.
    expect(broadcastEventToChildren).toHaveBeenCalledOnce()
    const [fanned] = broadcastEventToChildren.mock.calls[0]!
    expect(fanned.id).toBe(readyEvt.id)
    expect(fanned.category).toBe('system.ready-state')
  })

  it('the {} match-all filter reaches the bridge subscriber for an arbitrary-category event', () => {
    const realBus = makeRealEventBus()
    const broadcastEventToChildren =
      vi.fn<(event: SystemEvent, sourceNodeId: string, exceptChildId?: string) => void>()
    const bridgeDeps: UdsEventBridgeDeps = {
      registry: {
        onChildEvent: vi.fn(),
        sendEventToChild: vi.fn(),
        broadcastEventToChildren,
      },
      parentBus: realBus,
      parentNodeId: 'hub',
    }

    createUdsEventBridge(bridgeDeps)

    // Emit an arbitrary category that is NOT in EventCatalog — forward-compat guard.
    const arbitraryEvt: SystemEvent = {
      id: 'arbitrary-evt-1',
      timestamp: new Date(),
      source: { type: 'addon', id: 'some-future-addon', nodeId: 'agent-abc' },
      category: 'future.unknown-category',
      data: {},
    }

    realBus.emit(arbitraryEvt)

    expect(broadcastEventToChildren).toHaveBeenCalledOnce()
    const [fanned] = broadcastEventToChildren.mock.calls[0]!
    expect(fanned.id).toBe(arbitraryEvt.id)
    expect(fanned.category).toBe('future.unknown-category')
  })
})

// ---------------------------------------------------------------------------
// End-to-end: real registry + real UDS clients + real child buses (T5)
// ---------------------------------------------------------------------------
//
// Wires the FULL stack — LocalChildRegistry (parent) + createUdsEventBridge +
// a real parent IEventBus + two real LocalChildClient children each running a
// real createUdsEventBus — over real UDS sockets. Proves subscription-filtered
// fan-out end to end: a child receives ONLY the categories it subscribed to,
// the sibling fan is filtered too, an undeclared child gets everything, and the
// readiness delta is pinned to its subscriber (§5.6).

describe('createUdsEventBridge — end-to-end subscription-filtered fan-out', () => {
  const clients: LocalChildClient[] = []
  let registry: LocalChildRegistry | null = null
  let dispose: (() => void) | null = null

  afterEach(async () => {
    dispose?.()
    dispose = null
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  const nid = () => `hub-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`
  const flush = () => new Promise((r) => setTimeout(r, 30))

  async function makeChild(nodeId: string, childId: string): Promise<LocalChildClient> {
    const client = new LocalChildClient({
      nodeId,
      childId,
      caps: [{ capName: `${childId}-noop`, mode: 'singleton' }],
      dispatch: async () => 'ok',
    })
    clients.push(client)
    return client
  }

  it('a child receives only its subscribed categories; siblings and readiness are filtered', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const parentBus = makeRealEventBus()
    dispose = createUdsEventBridge({ registry, parentBus, parentNodeId: 'hub' })

    // Child A subscribes to pipeline.* (subscribe BEFORE start → rides register).
    const clientA = await makeChild(nodeId, 'A')
    const busA = createUdsEventBus(clientA, 'A')
    const gotA: string[] = []
    busA.subscribe({ category: 'pipeline.*' }, (e) => gotA.push(e.category))
    await clientA.start()

    // Child B subscribes only to the readiness delta category.
    const clientB = await makeChild(nodeId, 'B')
    const busB = createUdsEventBus(clientB, 'B')
    const gotB: string[] = []
    busB.subscribe({ category: 'system.ready-state' }, (e) => gotB.push(e.category))
    await clientB.start()
    await flush()

    // A cluster/parent-local emit of pipeline.trace reaches A only.
    parentBus.emit(makeEvent('pipeline.trace', { id: 'p-1' }))
    // A readiness delta reaches B only (§5.6 — reliable readiness forwarding).
    parentBus.emit(makeEvent('system.ready-state', { id: 'r-1' }))
    // An unsubscribed category reaches neither.
    parentBus.emit(makeEvent('device.online', { id: 'd-1' }))
    await flush()

    expect(gotA).toEqual(['pipeline.trace'])
    expect(gotB).toEqual(['system.ready-state'])

    // Sibling fan is also filtered: B emits pipeline.trace → parent fans to
    // siblings (A) filtered; A (subscribed to pipeline.*) receives it, B does
    // not echo to itself.
    gotA.length = 0
    gotB.length = 0
    busB.emit(makeEvent('pipeline.trace', { id: 'p-2' }))
    await flush()
    expect(gotA).toEqual(['pipeline.trace'])
    expect(gotB).toEqual([])
  })

  it('an undeclared (legacy) child receives every category (fail-open)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    const parentBus = makeRealEventBus()
    dispose = createUdsEventBridge({ registry, parentBus, parentNodeId: 'hub' })

    // A raw legacy child: registers WITHOUT eventPatterns and never declares.
    const legacy = createLocalTransport().createClient(nodeId)
    const channel = await legacy.connect()
    const got: string[] = []
    channel.onRequest(async () => 'ok')
    channel.onEvent((body) => {
      const msg = body as ParentEventMessage
      if (msg.kind === 'event') got.push(msg.event.category)
    })
    await channel.request({
      kind: 'register',
      childId: 'legacy',
      caps: [{ capName: 'legacy-noop', mode: 'singleton' }],
    })
    await flush()

    parentBus.emit(makeEvent('pipeline.trace', { id: 'l-1' }))
    parentBus.emit(makeEvent('device.online', { id: 'l-2' }))
    await flush()

    expect(got).toEqual(['pipeline.trace', 'device.online'])
    await legacy.close()
  })
})
