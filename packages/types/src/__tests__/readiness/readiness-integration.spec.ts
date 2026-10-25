/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
/**
 * Integration tests for `ReadinessRegistry` — §8.2 of the
 * system-readiness design spec. Exercises the emission contract and
 * consumer-side primitives end-to-end with a production-shaped async
 * event bus (microtask delivery, multiple subscribers, no ordering
 * tricks) and two registries simulating a "producer node" + "consumer
 * node" sharing the same bus.
 *
 * Still in-process — no Moleculer. That's §8.3 territory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  IEventBus,
  SystemEvent,
  EventFilter,
  KnownEventCategory,
  TypedSystemEvent,
  TypedEventFilter,
  ReadinessScope,
} from '../../interfaces/event-bus.js'
import { ReadinessRegistry } from '../../readiness/readiness-registry.js'

// ── Test bus — microtask delivery like SystemEventBus ────────────────

class MicrotaskEventBus implements IEventBus {
  private subs: Array<{ filter: EventFilter; handler: (event: SystemEvent) => void }> = []
  private readonly ring: SystemEvent[] = []

  emit(event: SystemEvent): void {
    this.ring.push(event)
    for (const s of this.subs) {
      if (!matchesFilter(event, s.filter)) continue
      queueMicrotask(() => {
        try {
          s.handler(event)
        } catch {
          /* swallow */
        }
      })
    }
  }

  subscribe<C extends KnownEventCategory>(
    filter: TypedEventFilter<C>,
    handler: (event: TypedSystemEvent<C>) => void,
  ): () => void
  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void
  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void {
    const entry = { filter, handler }
    this.subs.push(entry)
    return () => {
      this.subs = this.subs.filter((s) => s !== entry)
    }
  }

  getRecent(): readonly SystemEvent[] {
    return this.ring
  }
}

function matchesFilter(event: SystemEvent, filter: EventFilter): boolean {
  if (!filter.category) return true
  const cats = Array.isArray(filter.category) ? filter.category : [filter.category]
  return cats.some((c) => c === event.category)
}

/** Flush enough microtasks to drain nested subscriptions + replays. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const hubScope: ReadinessScope = { type: 'node', nodeId: 'hub' }
const agentScope: ReadinessScope = { type: 'node', nodeId: 'dev-agent-0' }

// ── Tests ─────────────────────────────────────────────────────────────

describe('ReadinessRegistry — integration (shared async bus)', () => {
  let bus: MicrotaskEventBus
  let producer: ReadinessRegistry
  let consumer: ReadinessRegistry

  beforeEach(() => {
    bus = new MicrotaskEventBus()
    producer = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'hub',
      generation: 'gen-PROD-A',
    })
    consumer = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'hub2',
      generation: 'gen-CONS',
    })
  })

  afterEach(() => {
    producer.close()
    consumer.close()
  })

  it('late consumer — mounts after producer emitted, reads current state from snapshot', async () => {
    producer.emitReady('detection-pipeline', hubScope)
    await flush()

    // Consumer mounts AFTER the ready fired. Its registry has already
    // ingested the event (same bus). Subscribing with `onReadyState`
    // should replay the current state.
    const handler = vi.fn()
    consumer.onReadyState('detection-pipeline', hubScope, handler)
    await flush()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({
      state: 'ready',
      epoch: 1,
      generation: 'gen-PROD-A',
    })
  })

  it('early consumer — awaits before producer exists, resolves when producer emits', async () => {
    const promise = consumer.awaitReady('detection-pipeline', hubScope, { timeoutMs: 1_000 })
    await flush()
    producer.emitReady('detection-pipeline', hubScope)
    await expect(promise).resolves.toBeUndefined()
  })

  it('producer restart — consumer sees down → ready(epoch+1) via onReadyState', async () => {
    const transitions: Array<{ state: string; epoch: number; generation: string }> = []
    consumer.onReadyState('detection-pipeline', hubScope, (t) => {
      transitions.push({ state: t.state, epoch: t.epoch, generation: t.generation })
    })

    producer.emitReady('detection-pipeline', hubScope)
    await flush()

    // Simulate the producer process going down — the supervisor on
    // consumer's side would fire this (demux of $node.disconnected).
    // Emit `down` keeping the existing generation so the registry
    // records the down without bumping epoch.
    producer.emitDown('detection-pipeline', hubScope)
    await flush()

    // Producer restarts with a new generation — a fresh registry
    // instance represents the respawned process.
    producer.close()
    producer = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'hub',
      generation: 'gen-PROD-B',
    })
    producer.emitReady('detection-pipeline', hubScope)
    await flush()

    expect(transitions.map((t) => t.state)).toEqual(['ready', 'down', 'ready'])
    expect(transitions[0]!.epoch).toBe(1)
    expect(transitions[2]!.epoch).toBe(2)
    expect(transitions[2]!.generation).toBe('gen-PROD-B')
  })

  it('same-epoch no-op — repeat ready with identical generation never re-fires the handler', async () => {
    const handler = vi.fn()
    consumer.onReadyState('detection-pipeline', hubScope, handler)

    producer.emitReady('detection-pipeline', hubScope)
    producer.emitReady('detection-pipeline', hubScope)
    producer.emitReady('detection-pipeline', hubScope)
    await flush()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0].epoch).toBe(1)
  })

  it('teardown — emitDown from producer reaches consumer', async () => {
    const handler = vi.fn()
    consumer.onReadyState('decoder-nodeav', agentScope, handler)

    producer.emitReady('decoder-nodeav', agentScope)
    await flush()
    producer.emitDown('decoder-nodeav', agentScope)
    await flush()

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls[0]![0].state).toBe('ready')
    expect(handler.mock.calls[1]![0].state).toBe('down')
  })

  it('short blip — consumer debounce policy skips sub-threshold bounces', async () => {
    // Consumer policy: treat down→ready within DEBOUNCE_MS as noise.
    // Verifies the primitive exposes the info needed for the policy.
    const DEBOUNCE_MS = 200
    const rebuilds: Array<{ epoch: number; reason: string }> = []
    let lastDownAt: number | null = null
    let lastSeenEpoch = 0

    consumer.onReadyState('detection-pipeline', hubScope, (t) => {
      if (t.state === 'down') {
        lastDownAt = Date.now()
        return
      }
      if (t.state === 'ready') {
        const blip = lastDownAt !== null && Date.now() - lastDownAt < DEBOUNCE_MS
        const epochChanged = t.epoch > lastSeenEpoch
        lastSeenEpoch = t.epoch
        if (epochChanged && !blip) rebuilds.push({ epoch: t.epoch, reason: 'real-restart' })
        if (epochChanged && blip) rebuilds.push({ epoch: t.epoch, reason: 'absorbed-blip' })
      }
    })

    producer.emitReady('detection-pipeline', hubScope)
    await flush()
    expect(rebuilds).toHaveLength(1)
    expect(rebuilds[0]!.reason).toBe('real-restart')

    // Short blip: down + ready within the debounce window, but with
    // a new generation (producer really did restart fast).
    producer.emitDown('detection-pipeline', hubScope)
    await flush()
    producer.close()
    producer = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'hub',
      generation: 'gen-PROD-B',
    })
    producer.emitReady('detection-pipeline', hubScope)
    await flush()

    // Consumer observes the bounce but policy marks it absorbed.
    expect(rebuilds).toHaveLength(2)
    expect(rebuilds[1]).toMatchObject({ epoch: 2, reason: 'absorbed-blip' })

    // A longer-duration down yields a real rebuild — wait >debounce.
    producer.emitDown('detection-pipeline', hubScope)
    await flush()
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50))
    producer.close()
    producer = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'hub',
      generation: 'gen-PROD-C',
    })
    producer.emitReady('detection-pipeline', hubScope)
    await flush()

    expect(rebuilds).toHaveLength(3)
    expect(rebuilds[2]).toMatchObject({ epoch: 3, reason: 'real-restart' })
  })

  it('multi-cap producer — a single restart fires separate transitions per cap', async () => {
    const xHandler = vi.fn()
    const yHandler = vi.fn()
    consumer.onReadyState('detection-pipeline', hubScope, xHandler)
    consumer.onReadyState('decoder-nodeav', hubScope, yHandler)

    producer.emitReady('detection-pipeline', hubScope)
    producer.emitReady('decoder-nodeav', hubScope)
    await flush()

    producer.emitDown('detection-pipeline', hubScope)
    producer.emitDown('decoder-nodeav', hubScope)
    await flush()

    producer.close()
    producer = new ReadinessRegistry({
      eventBus: bus,
      sourceNodeId: 'hub',
      generation: 'gen-PROD-B',
    })
    producer.emitReady('detection-pipeline', hubScope)
    producer.emitReady('decoder-nodeav', hubScope)
    await flush()

    // Each cap has its own epoch counter.
    const xCalls = xHandler.mock.calls.map((c) => c[0])
    const yCalls = yHandler.mock.calls.map((c) => c[0])
    expect(xCalls.map((c) => `${c.state}:${c.epoch}`)).toEqual(['ready:1', 'down:1', 'ready:2'])
    expect(yCalls.map((c) => `${c.state}:${c.epoch}`)).toEqual(['ready:1', 'down:1', 'ready:2'])
  })

  it('multi-consumer — several subscribers each receive their own copy of the transition', async () => {
    const a = vi.fn()
    const b = vi.fn()
    const c = vi.fn()
    consumer.onReadyState('detection-pipeline', hubScope, a)
    consumer.onReadyState('detection-pipeline', hubScope, b)
    consumer.onReadyState('detection-pipeline', hubScope, c)

    producer.emitReady('detection-pipeline', hubScope)
    await flush()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(c).toHaveBeenCalledTimes(1)
    // Epoch is the SAME across consumers — registry owns the counter.
    expect(a.mock.calls[0]![0].epoch).toBe(1)
    expect(b.mock.calls[0]![0].epoch).toBe(1)
    expect(c.mock.calls[0]![0].epoch).toBe(1)
  })
})
