/**
 * Unit tests for `createUdsEventBus` (C1 — child-side UDS event bus).
 *
 * Uses a fake `UdsEventChannel` implemented with `vi.fn()` — no real UDS
 * socket, no Moleculer broker. All assertions are purely in-process.
 *
 * Coverage goals:
 *   1. `emit` delivers to local subscribers synchronously AND sends the
 *      enriched event (with `sourceAddonId`) to the parent via
 *      `client.emitEvent`.
 *   2. A parent→child event injected through `client.onEvent` is delivered
 *      to local subscribers and is NOT echoed back to the parent
 *      (`client.emitEvent` must NOT be called for inbound events).
 *   3. A child runner bus is ONE-SHOT: every category (audit-grade or
 *      high-frequency) reaches live subscribers, but NOTHING is retained in
 *      `recent[]` — only the hub main process serves the audit registry.
 *   4. `subscribe` filter semantics: a subscriber whose category pattern
 *      does not match the emitted category does not receive the event.
 *   5. `getRecent` on a child bus always returns `[]` (one-shot / no retention).
 *   6. Unsubscribe: the returned disposer removes the handler from the map.
 */

import type { SystemEvent } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { matchesPattern } from '../../moleculer/event-bus-core.js'
import type { UdsEventChannel } from '../../transport/uds-event-bus.js'
import { createUdsEventBus } from '../../transport/uds-event-bus.js'

// ---------------------------------------------------------------------------
// Fake UdsEventChannel
// ---------------------------------------------------------------------------

function makeChannel(): {
  channel: UdsEventChannel
  emitEvent: ReturnType<typeof vi.fn<(event: SystemEvent) => void>>
  updateEventPatterns: ReturnType<
    typeof vi.fn<(ownerId: string, patterns: readonly string[]) => void>
  >
  triggerOnEvent: (event: SystemEvent) => void
  onEventRegistrations: () => number
} {
  const emitEvent = vi.fn<(event: SystemEvent) => void>()
  const updateEventPatterns = vi.fn<(ownerId: string, patterns: readonly string[]) => void>()
  let capturedHandler: ((event: SystemEvent) => void) | null = null
  let registrations = 0

  const channel: UdsEventChannel = {
    emitEvent,
    updateEventPatterns,
    // SINGLE-SLOT — mirrors `LocalChildClient.onEvent`: a new handler REPLACES
    // the previous one. The group-runner regression tests below depend on this
    // fake preserving that replacement semantic exactly.
    onEvent(handler: (event: SystemEvent) => void): void {
      registrations++
      capturedHandler = handler
    },
  }

  function triggerOnEvent(event: SystemEvent): void {
    if (capturedHandler === null) {
      throw new Error('No onEvent handler registered — call createUdsEventBus first')
    }
    capturedHandler(event)
  }

  return {
    channel,
    emitEvent,
    updateEventPatterns,
    triggerOnEvent,
    onEventRegistrations: () => registrations,
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

describe('createUdsEventBus', () => {
  let emitEvent: ReturnType<typeof vi.fn<(event: SystemEvent) => void>>
  let updateEventPatterns: ReturnType<
    typeof vi.fn<(ownerId: string, patterns: readonly string[]) => void>
  >
  let triggerOnEvent: (event: SystemEvent) => void
  let channel: UdsEventChannel

  beforeEach(() => {
    const fake = makeChannel()
    emitEvent = fake.emitEvent
    updateEventPatterns = fake.updateEventPatterns
    triggerOnEvent = fake.triggerOnEvent
    channel = fake.channel
  })

  // ── 1. Local delivery + parent forwarding ──────────────────────────────────

  it('emit delivers to local subscriber synchronously', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    bus.subscribe({ category: 'addon.started' }, (e) => {
      received.push(e)
    })

    const evt = makeEvent('addon.started')
    bus.emit(evt)

    expect(received).toHaveLength(1)
    expect(received[0]!.id).toBe(evt.id)
  })

  it('emit calls client.emitEvent with sourceAddonId enrichment', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const evt = makeEvent('addon.started')
    bus.emit(evt)

    expect(emitEvent).toHaveBeenCalledOnce()
    const sent = emitEvent.mock.calls[0]![0] as SystemEvent & {
      sourceAddonId?: string
    }
    expect(sent.id).toBe(evt.id)
    expect(sent.sourceAddonId).toBe('my-addon')
  })

  it('emit enriched event carries the original category and source', () => {
    const bus = createUdsEventBus(channel, 'addon-stream')
    const evt = makeEvent('device.online', {
      source: { type: 'device', id: 42 },
    })
    bus.emit(evt)

    const sent = emitEvent.mock.calls[0]![0] as SystemEvent & {
      sourceAddonId?: string
    }
    expect(sent.category).toBe('device.online')
    expect(sent.source.id).toBe(42)
  })

  // ── 2. Parent→child inbound — no echo ─────────────────────────────────────

  it('parent→child event is delivered to local subscribers', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    bus.subscribe({ category: 'addon.started' }, (e) => {
      received.push(e)
    })

    const inbound = makeEvent('addon.started')
    triggerOnEvent(inbound)

    expect(received).toHaveLength(1)
    expect(received[0]!.id).toBe(inbound.id)
  })

  it('parent→child event does NOT call client.emitEvent (no echo)', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.subscribe({ category: 'addon.started' }, () => {
      /* noop */
    })

    const inbound = makeEvent('addon.started')
    triggerOnEvent(inbound)

    expect(emitEvent).not.toHaveBeenCalled()
  })

  // ── 3. High-frequency deny-list ────────────────────────────────────────────

  it('high-frequency category reaches live subscribers but is NOT added to recent[]', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    bus.subscribe({ category: 'pipeline.progress' }, (e) => {
      received.push(e)
    })

    const evt = makeEvent('pipeline.progress')
    bus.emit(evt)

    // Live subscriber receives it.
    expect(received).toHaveLength(1)
    // NOT in recent[].
    expect(bus.getRecent()).toHaveLength(0)
  })

  it('audit-grade category is NOT retained on a child bus (one-shot) but IS delivered', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    bus.subscribe({ category: 'addon.started' }, (e) => {
      received.push(e)
    })
    const evt = makeEvent('addon.started')
    bus.emit(evt)

    // Delivered to the live subscriber…
    expect(received).toHaveLength(1)
    expect(received[0]!.id).toBe(evt.id)
    // …but NOT retained: a child runner keeps zero recent[].
    expect(bus.getRecent()).toHaveLength(0)
  })

  it('detection.result is high-frequency and excluded from recent[]', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.emit(makeEvent('detection.result'))
    expect(bus.getRecent()).toHaveLength(0)
  })

  it('metrics.node-resources-snapshot is high-frequency and excluded from recent[]', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.emit(makeEvent('metrics.node-resources-snapshot'))
    expect(bus.getRecent()).toHaveLength(0)
  })

  it('device.online (audit-grade) is still NOT retained on a child bus', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.emit(makeEvent('device.online'))
    expect(bus.getRecent()).toHaveLength(0)
  })

  // ── 4. subscribe filter semantics ─────────────────────────────────────────

  it('subscriber with non-matching category pattern does not receive the event', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    bus.subscribe({ category: 'device.*' }, (e) => {
      received.push(e)
    })

    bus.emit(makeEvent('addon.started'))

    expect(received).toHaveLength(0)
  })

  it('wildcard subscriber receives all categories', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    bus.subscribe({ category: '**' }, (e) => {
      received.push(e)
    })

    bus.emit(makeEvent('addon.started'))
    bus.emit(makeEvent('device.online'))

    expect(received).toHaveLength(2)
  })

  it('device.* pattern matches device.online but not addon.started', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    bus.subscribe({ category: 'device.*' }, (e) => {
      received.push(e)
    })

    bus.emit(makeEvent('device.online'))
    bus.emit(makeEvent('addon.started'))

    expect(received).toHaveLength(1)
    expect(received[0]!.category).toBe('device.online')
  })

  // ── 5. getRecent — always empty on a one-shot child bus ───────────────────

  it('getRecent is always empty on a child bus even after audit-grade emits', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.emit(makeEvent('addon.started'))
    bus.emit(makeEvent('device.online'))

    expect(bus.getRecent()).toHaveLength(0)
  })

  it('getRecent with a category filter is still empty on a child bus', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.emit(makeEvent('addon.started'))
    bus.emit(makeEvent('device.online'))

    expect(bus.getRecent({ category: 'addon.started' })).toHaveLength(0)
  })

  it('getRecent with a limit is still empty on a child bus', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.emit(makeEvent('addon.started'))
    bus.emit(makeEvent('device.online'))
    bus.emit(makeEvent('addon.stopped'))

    expect(bus.getRecent(undefined, 2)).toHaveLength(0)
  })

  // ── 6. Unsubscribe ────────────────────────────────────────────────────────

  it('unsubscribe removes the handler — subsequent emits are not delivered', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    const off = bus.subscribe({ category: 'addon.started' }, (e) => {
      received.push(e)
    })

    bus.emit(makeEvent('addon.started'))
    expect(received).toHaveLength(1)

    off()
    bus.emit(makeEvent('addon.started'))
    expect(received).toHaveLength(1) // still 1 — second emit was not delivered
  })

  // ── 7. Multiple subscribers ────────────────────────────────────────────────

  it('multiple subscribers on the same category all receive the event', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const r1: SystemEvent[] = []
    const r2: SystemEvent[] = []
    bus.subscribe({ category: 'addon.started' }, (e) => {
      r1.push(e)
    })
    bus.subscribe({ category: 'addon.started' }, (e) => {
      r2.push(e)
    })

    bus.emit(makeEvent('addon.started'))

    expect(r1).toHaveLength(1)
    expect(r2).toHaveLength(1)
  })

  // ── 8. Inbound parent→child events are delivered but never retained ───────

  it('parent→child audit-grade event is delivered but NOT retained on a child bus', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const received: SystemEvent[] = []
    bus.subscribe({ category: 'addon.started' }, (e) => {
      received.push(e)
    })
    const inbound = makeEvent('addon.started')
    triggerOnEvent(inbound)

    // Delivered to the live subscriber…
    expect(received).toHaveLength(1)
    expect(received[0]!.id).toBe(inbound.id)
    // …but not retained (one-shot child bus).
    expect(bus.getRecent()).toHaveLength(0)
  })

  it('parent→child high-frequency event is NOT added to recent[]', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    triggerOnEvent(makeEvent('pipeline.progress'))
    expect(bus.getRecent()).toHaveLength(0)
  })

  // ── 9. Subscription mirroring — the child reports its handler-map keys ─────

  it('subscribe reports the category-pattern key set to the client (keyed by addonId)', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.subscribe({ category: 'device.bindings-changed' }, () => {})

    expect(updateEventPatterns).toHaveBeenLastCalledWith('my-addon', ['device.bindings-changed'])
  })

  it('a {} (no-category) filter reports the wildcard "*" pattern (fail-open)', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.subscribe({}, () => {})

    expect(updateEventPatterns).toHaveBeenLastCalledWith('my-addon', ['*'])
  })

  it('a second subscriber on the SAME category does not change the reported key set', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.subscribe({ category: 'system.ready-state' }, () => {})
    bus.subscribe({ category: 'system.ready-state' }, () => {})

    // Two subscribe() calls → two reports, but the SET is identical both times.
    const reports = updateEventPatterns.mock.calls.map((c) => c[1])
    expect(reports).toEqual([['system.ready-state'], ['system.ready-state']])
  })

  it('unsubscribing the LAST handler for a category deletes the map key AND reports the shrunk set', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const off = bus.subscribe({ category: 'system.ready-state' }, () => {})
    bus.subscribe({ category: 'agent.offline' }, () => {})

    updateEventPatterns.mockClear()
    off()

    // Reported set no longer contains the removed category (empty-set leak fixed).
    expect(updateEventPatterns).toHaveBeenCalledOnce()
    expect(updateEventPatterns.mock.calls[0]![1]).toEqual(['agent.offline'])
  })

  it('unsubscribing the last of TWO handlers on one category keeps the key until the set empties', () => {
    const bus = createUdsEventBus(channel, 'my-addon')
    const offA = bus.subscribe({ category: 'system.ready-state' }, () => {})
    bus.subscribe({ category: 'system.ready-state' }, () => {})

    updateEventPatterns.mockClear()
    offA() // one handler still remains on the category

    // Key still present — one subscriber remains.
    expect(updateEventPatterns.mock.calls.at(-1)![1]).toEqual(['system.ready-state'])
  })

  // ── 10. Parity: parent forward-decision ≡ child map-key delivery gate ──────
  //
  // The parent forwards iff `∃ p ∈ reportedSet: matchesPattern(p, category)`.
  // The child delivers iff `∃ p ∈ handlers.keys(): matchesPattern(p, category)`.
  // Because the reported set IS `[...handlers.keys()]`, the two decisions are
  // provably identical for every (patterns, category). This pins that the set
  // the child reports is exactly the set its own `deliverShared` gate uses.

  // ── 11. Group runner: several buses share ONE channel ──────────────────────
  //
  // A grouped runner (`execution.group`, e.g. `detection` = pipeline-runner +
  // detection-pipeline + motion-wasm) creates one bus PER ADDON on the SAME
  // `LocalChildClient`, whose `onEvent` slot is SINGLE — a later registration
  // replaces the earlier one. These tests pin the shared-state contract that
  // makes that safe. The first one is the exact production regression that
  // silently killed every camera's motion boxes: pipeline-runner subscribed to
  // `motion.on-motion-changed`, motion-wasm's bus was created LAST, and every
  // parent→child motion event was delivered into motion-wasm's (subscriber-less)
  // private state while pipeline-runner's subscriber starved.

  it('parent→child event reaches an EARLIER bus subscriber even after a LATER bus is created on the same channel', () => {
    const busA = createUdsEventBus(channel, 'pipeline-runner')
    const received: SystemEvent[] = []
    busA.subscribe({ category: 'motion.on-motion-changed' }, (e) => {
      received.push(e)
    })

    // A sibling co-located addon's context is created AFTER — its bus
    // construction must not steal parent→child delivery from busA.
    createUdsEventBus(channel, 'motion-wasm')

    const inbound = makeEvent('motion.on-motion-changed')
    triggerOnEvent(inbound)

    expect(received).toHaveLength(1)
    expect(received[0]!.id).toBe(inbound.id)
  })

  it('registers the single-slot client.onEvent handler exactly ONCE per channel', () => {
    const fake = makeChannel()
    createUdsEventBus(fake.channel, 'pipeline-runner')
    createUdsEventBus(fake.channel, 'detection-pipeline')
    createUdsEventBus(fake.channel, 'motion-wasm')

    expect(fake.onEventRegistrations()).toBe(1)
  })

  it('an in-process sibling emit reaches another co-located addon subscriber synchronously (broker-bus parity)', () => {
    const busA = createUdsEventBus(channel, 'pipeline-runner')
    const busB = createUdsEventBus(channel, 'motion-wasm')
    const received: Array<SystemEvent & { sourceAddonId?: string }> = []
    busA.subscribe({ category: 'detection.motion-analysis' }, (e) => {
      received.push(e)
    })

    busB.emit(makeEvent('detection.motion-analysis'))

    // Delivered locally to the sibling's subscriber…
    expect(received).toHaveLength(1)
    // …attributed to the EMITTING addon…
    expect(received[0]!.sourceAddonId).toBe('motion-wasm')
    // …and still forwarded to the parent exactly once (no double-send).
    expect(emitEvent).toHaveBeenCalledOnce()
  })

  it('reported pattern set drives the same forward decision the child uses to deliver', () => {
    const received: string[] = []
    const bus = createUdsEventBus(channel, 'my-addon')
    bus.subscribe({ category: 'pipeline.*' }, (e) => received.push(e.category))
    bus.subscribe({ category: 'system.ready-state' }, (e) => received.push(e.category))

    const reported = updateEventPatterns.mock.calls.at(-1)![1]
    const parentWouldForward = (category: string): boolean =>
      reported.some((p) => matchesPattern(p, category))

    const categories = [
      'pipeline.trace',
      'pipeline.progress',
      'system.ready-state',
      'device.online',
      'agent.offline',
    ]
    for (const category of categories) {
      received.length = 0
      // Child-side delivery: parent forwards the event, child's deliverShared
      // gates it against its own handler-map keys.
      triggerOnEvent(makeEvent(category))
      const childDelivered = received.length > 0
      // Parity: the parent's forward decision (over the reported set) must
      // exactly match whether the child would deliver it.
      expect(parentWouldForward(category)).toBe(childDelivered)
    }
  })
})
