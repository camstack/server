/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, no-restricted-syntax */
/**
 * Unit tests for `ReadinessRegistry` — §8.1 of the system-readiness
 * design spec. Covers scope matching, epoch derivation, idempotent
 * replays, subscription dispatch, timeout, abort, and late-subscriber
 * snapshot hydration.
 *
 * Uses a minimal in-memory synchronous `IEventBus` mock so tests are
 * deterministic without fake timers — the production
 * `@camstack/system::SystemEventBus` delivers via `queueMicrotask`, but
 * that behaviour is exercised in the integration layer (§8.2).
 *
 * Mock payloads are intentionally `any`-typed for test brevity; the
 * disables above scope the unsafe-* and no-restricted-syntax rules
 * to this file only.
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
import { EventCategory } from '../../enums/event-category.js'
import {
  ReadinessRegistry,
  ReadinessTimeoutError,
  readinessKey,
  emitDownForOwnedCaps,
} from '../../readiness/readiness-registry.js'

// ── Test helpers ──────────────────────────────────────────────────────

/**
 * Minimal synchronous in-memory bus — good enough for unit tests.
 * Delivers events in the same tick so assertions can run without
 * needing fake timers or microtask flushes.
 */
class TestEventBus implements IEventBus {
  private subs: Array<{ filter: EventFilter; handler: (event: SystemEvent) => void }> = []
  emitted: SystemEvent[] = []

  emit(event: SystemEvent): void {
    this.emitted.push(event)
    for (const s of this.subs) {
      if (matchesFilter(event, s.filter)) s.handler(event)
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
    return this.emitted
  }
}

function matchesFilter(event: SystemEvent, filter: EventFilter): boolean {
  if (!filter.category) return true
  const cats = Array.isArray(filter.category) ? filter.category : [filter.category]
  return cats.some((c) => c === event.category)
}

function makeRegistry(opts?: { now?: () => number; generation?: string; sourceNodeId?: string }): {
  bus: TestEventBus
  reg: ReadinessRegistry
} {
  const bus = new TestEventBus()
  const reg = new ReadinessRegistry({
    eventBus: bus,
    sourceNodeId: opts?.sourceNodeId ?? 'node-a',
    generation: opts?.generation ?? 'gen-A',
    now: opts?.now,
  })
  return { bus, reg }
}

const nodeA: ReadinessScope = { type: 'node', nodeId: 'a' }
const nodeB: ReadinessScope = { type: 'node', nodeId: 'b' }
const globalScope: ReadinessScope = { type: 'global' }
const globalOther: ReadinessScope = { type: 'global' }

// ── Tests ─────────────────────────────────────────────────────────────

describe('ReadinessRegistry — snapshot + epoch', () => {
  let bus: TestEventBus
  let reg: ReadinessRegistry

  beforeEach(() => {
    ;({ bus, reg } = makeRegistry())
  })
  afterEach(() => {
    reg.close()
  })

  it('empty snapshot — awaitReady pends until a matching ready arrives', async () => {
    const promise = reg.awaitReady('cap-x', nodeA, { timeoutMs: 1_000 })
    // No ready yet — the promise should not settle synchronously.
    let settled = false
    void promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    // One more tick to let `promise.then` register; still not settled.
    await Promise.resolve()
    expect(settled).toBe(false)

    reg.emitReady('cap-x', nodeA)
    await expect(promise).resolves.toBeUndefined()
  })

  it('populated snapshot — awaitReady resolves immediately when already ready', async () => {
    reg.emitReady('cap-x', nodeA)
    await expect(reg.awaitReady('cap-x', nodeA)).resolves.toBeUndefined()
  })

  it('scope matching — node:a does not match node:b or global', () => {
    const handler = vi.fn()
    const unsubscribe = reg.onReadyState('cap-x', nodeA, handler)
    reg.emitReady('cap-x', nodeB)
    reg.emitReady('cap-x', globalScope)
    expect(handler).not.toHaveBeenCalled()
    reg.emitReady('cap-x', nodeA)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({
      capName: 'cap-x',
      scope: nodeA,
      state: 'ready',
    })
    unsubscribe()
  })

  it('epoch stays stable for same-generation repeated ready emits', () => {
    const handler = vi.fn()
    reg.onReadyState('cap-x', nodeA, handler)
    reg.emitReady('cap-x', nodeA) // epoch=1
    reg.emitReady('cap-x', nodeA) // idempotent — same gen + same state
    reg.emitReady('cap-x', nodeA) // idempotent
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0].epoch).toBe(1)
  })

  it('epoch bumps on generation change (producer restart scenario)', () => {
    const handler = vi.fn()
    reg.onReadyState('cap-x', nodeA, handler)

    // First producer — gen-A, registry's own emitReady uses gen-A.
    reg.emitReady('cap-x', nodeA)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0].epoch).toBe(1)

    // Producer goes down, comes back with new generation. Simulate by
    // injecting a payload directly on the bus (as if a remote node
    // emitted with a fresh generation).
    bus.emit({
      id: 'e1',
      timestamp: new Date(),
      source: { type: 'capability', id: 'cap-x', nodeId: 'node-a' },
      category: EventCategory.SystemReadyState,
      data: {
        capName: 'cap-x',
        scope: nodeA,
        state: 'down',
        generation: 'gen-A',
        sourceNodeId: 'node-a',
        ts: Date.now(),
      },
    })
    bus.emit({
      id: 'e2',
      timestamp: new Date(),
      source: { type: 'capability', id: 'cap-x', nodeId: 'node-a' },
      category: EventCategory.SystemReadyState,
      data: {
        capName: 'cap-x',
        scope: nodeA,
        state: 'ready',
        generation: 'gen-B',
        sourceNodeId: 'node-a',
        ts: Date.now(),
      },
    })

    // Handler should have fired 3 total: initial ready, down, ready(epoch+1)
    expect(handler).toHaveBeenCalledTimes(3)
    const transitions = handler.mock.calls.map((c) => c[0])
    expect(transitions[0]).toMatchObject({ state: 'ready', epoch: 1, generation: 'gen-A' })
    expect(transitions[1]).toMatchObject({ state: 'down', epoch: 1 })
    expect(transitions[2]).toMatchObject({ state: 'ready', epoch: 2, generation: 'gen-B' })
  })

  it('global scope is independent from node scope', () => {
    const nodeHandler = vi.fn()
    const globalHandler = vi.fn()
    reg.onReadyState('cap-x', nodeA, nodeHandler)
    reg.onReadyState('cap-x', globalScope, globalHandler)
    reg.emitReady('cap-x', globalScope)
    expect(nodeHandler).not.toHaveBeenCalled()
    expect(globalHandler).toHaveBeenCalledTimes(1)
  })

  it('snapshot via get() reflects the most recent transition', () => {
    expect(reg.get('cap-x', nodeA)).toBeNull()
    reg.emitReady('cap-x', nodeA)
    expect(reg.get('cap-x', nodeA)).toMatchObject({ state: 'ready', epoch: 1, generation: 'gen-A' })
    reg.emitDown('cap-x', nodeA)
    expect(reg.get('cap-x', nodeA)).toMatchObject({ state: 'down' })
  })

  it('device scope is independent from node and global scope', () => {
    const nodeHandler = vi.fn()
    const deviceHandler = vi.fn()
    const globalHandler = vi.fn()
    const deviceA: ReadinessScope = { type: 'device', deviceId: 42 }
    reg.onReadyState('cap-x', nodeA, nodeHandler)
    reg.onReadyState('cap-x', deviceA, deviceHandler)
    reg.onReadyState('cap-x', globalScope, globalHandler)
    // A device-scoped payload arrives on the bus (mirrors what
    // `registerNativeCap` emits). Regression guard: `ingest` used to
    // filter out anything that wasn't global/node, silently dropping
    // device-scope and breaking every per-device `awaitReady`.
    bus.emit({
      id: 'e-dev',
      timestamp: new Date(),
      source: { type: 'capability', id: 'cap-x', nodeId: 'worker-A' },
      category: EventCategory.SystemReadyState,
      data: {
        capName: 'cap-x',
        scope: deviceA,
        state: 'ready',
        generation: 'gen-dev',
        sourceNodeId: 'worker-A',
        ts: Date.now(),
      },
    })
    expect(nodeHandler).not.toHaveBeenCalled()
    expect(globalHandler).not.toHaveBeenCalled()
    expect(deviceHandler).toHaveBeenCalledTimes(1)
    expect(deviceHandler.mock.calls[0]![0]).toMatchObject({
      capName: 'cap-x',
      scope: deviceA,
      state: 'ready',
      epoch: 1,
    })
    expect(reg.get('cap-x', deviceA)).toMatchObject({ state: 'ready', epoch: 1 })
  })

  it('emitDownForOwnedCaps fires a down transition per owned cap', () => {
    reg.emitReady('cap-x', nodeA)
    reg.emitReady('cap-y', globalScope)
    const downHandler = vi.fn()
    reg.onReadyState('cap-x', nodeA, downHandler)
    reg.onReadyState('cap-y', globalScope, downHandler)
    emitDownForOwnedCaps(reg, [
      { capName: 'cap-x', scope: nodeA },
      { capName: 'cap-y', scope: globalScope },
    ])
    // 2 current-state replays + 2 down transitions
    expect(
      downHandler.mock.calls.some((c) => c[0].state === 'down' && c[0].capName === 'cap-x'),
    ).toBe(true)
    expect(
      downHandler.mock.calls.some((c) => c[0].state === 'down' && c[0].capName === 'cap-y'),
    ).toBe(true)
  })
})

describe('ReadinessRegistry — awaitReady semantics', () => {
  let reg: ReadinessRegistry

  beforeEach(() => {
    ;({ reg } = makeRegistry())
  })
  afterEach(() => {
    reg.close()
  })

  it('rejects with ReadinessTimeoutError after timeoutMs', async () => {
    const promise = reg.awaitReady('cap-x', nodeA, { timeoutMs: 50 })
    await expect(promise).rejects.toBeInstanceOf(ReadinessTimeoutError)
  })

  it('timeout error carries the cap + scope + waited duration', async () => {
    try {
      await reg.awaitReady('cap-x', nodeA, { timeoutMs: 30 })
      throw new Error('should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(ReadinessTimeoutError)
      const t = err as ReadinessTimeoutError
      expect(t.capName).toBe('cap-x')
      expect(t.scope).toEqual(nodeA)
      expect(t.waitedMs).toBeGreaterThanOrEqual(25)
    }
  })

  it('rejects immediately when signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort(new Error('pre-aborted'))
    await expect(
      reg.awaitReady('cap-x', nodeA, { signal: ac.signal, timeoutMs: 10_000 }),
    ).rejects.toThrow('pre-aborted')
  })

  it('rejects when signal aborts mid-wait', async () => {
    const ac = new AbortController()
    const promise = reg.awaitReady('cap-x', nodeA, { signal: ac.signal, timeoutMs: 10_000 })
    setTimeout(() => ac.abort(new Error('cancelled')), 20)
    await expect(promise).rejects.toThrow('cancelled')
  })

  it('resolves on the ready transition even if signal is wired but not aborted', async () => {
    const ac = new AbortController()
    const promise = reg.awaitReady('cap-x', nodeA, { signal: ac.signal, timeoutMs: 1_000 })
    reg.emitReady('cap-x', nodeA)
    await expect(promise).resolves.toBeUndefined()
  })
})

describe('ReadinessRegistry — subscriptions', () => {
  let reg: ReadinessRegistry

  beforeEach(() => {
    ;({ reg } = makeRegistry())
  })
  afterEach(() => {
    reg.close()
  })

  it('onReadyState initial callback reports current state for a late subscriber', async () => {
    reg.emitReady('cap-x', nodeA)
    const handler = vi.fn()
    reg.onReadyState('cap-x', nodeA, handler)
    // Initial replay is scheduled via queueMicrotask — flush it.
    await Promise.resolve()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]).toMatchObject({
      state: 'ready',
      epoch: 1,
      durationInPrevState: 0,
    })
  })

  it('unsubscribing stops the handler from firing', () => {
    const handler = vi.fn()
    const unsubscribe = reg.onReadyState('cap-x', nodeA, handler)
    unsubscribe()
    reg.emitReady('cap-x', nodeA)
    expect(handler).not.toHaveBeenCalled()
  })

  it('handler receives durationInPrevState reflecting time between transitions', () => {
    let t = 1_000
    const { reg: r } = makeRegistry({ now: () => t })
    const handler = vi.fn()
    r.onReadyState('cap-x', nodeA, handler)
    r.emitReady('cap-x', nodeA) // ts=1000
    t = 1_500
    r.emitDown('cap-x', nodeA) // ts=1500
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls[1]![0].durationInPrevState).toBe(500)
    r.close()
  })

  it('a throwing handler does not affect other subscribers', () => {
    const good = vi.fn()
    reg.onReadyState('cap-x', nodeA, () => {
      throw new Error('boom')
    })
    reg.onReadyState('cap-x', nodeA, good)
    reg.emitReady('cap-x', nodeA)
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('readinessKey distinguishes capName and scope', () => {
    expect(readinessKey('a', nodeA)).not.toBe(readinessKey('a', nodeB))
    expect(readinessKey('a', globalScope)).not.toBe(readinessKey('b', globalScope))
    expect(readinessKey('a', globalOther)).not.toBe(readinessKey('a', nodeA))
  })
})

describe('ReadinessRegistry — $node.disconnected demux', () => {
  it('fires down transitions for every owned cap', () => {
    const { reg } = makeRegistry()
    reg.emitReady('cap-x', { type: 'node', nodeId: 'remote' })
    reg.emitReady('cap-y', { type: 'node', nodeId: 'remote' })
    reg.emitReady('cap-z', { type: 'global' })
    const xHandler = vi.fn()
    const yHandler = vi.fn()
    const zHandler = vi.fn()
    reg.onReadyState('cap-x', { type: 'node', nodeId: 'remote' }, xHandler)
    reg.onReadyState('cap-y', { type: 'node', nodeId: 'remote' }, yHandler)
    reg.onReadyState('cap-z', { type: 'global' }, zHandler)
    emitDownForOwnedCaps(reg, [
      { capName: 'cap-x', scope: { type: 'node', nodeId: 'remote' } },
      { capName: 'cap-y', scope: { type: 'node', nodeId: 'remote' } },
    ])
    const downs = (h: typeof xHandler): number =>
      h.mock.calls.filter((c) => c[0].state === 'down').length
    expect(downs(xHandler)).toBe(1)
    expect(downs(yHandler)).toBe(1)
    expect(downs(zHandler)).toBe(0) // global not affected
    reg.close()
  })
})

describe('ReadinessRegistry — agent.offline auto-heal', () => {
  it('synthesizes down for every node-scoped cap on the disconnected agent', () => {
    const { bus, reg } = makeRegistry()
    // Two caps on node-a, one on node-b, one global.
    reg.emitReady('cap-x', { type: 'node', nodeId: 'a' })
    reg.emitReady('cap-y', { type: 'node', nodeId: 'a' })
    reg.emitReady('cap-z', { type: 'node', nodeId: 'b' })
    reg.emitReady('cap-w', { type: 'global' })

    const xH = vi.fn()
    const yH = vi.fn()
    const zH = vi.fn()
    const wH = vi.fn()
    reg.onReadyState('cap-x', { type: 'node', nodeId: 'a' }, xH)
    reg.onReadyState('cap-y', { type: 'node', nodeId: 'a' }, yH)
    reg.onReadyState('cap-z', { type: 'node', nodeId: 'b' }, zH)
    reg.onReadyState('cap-w', { type: 'global' }, wH)

    // Fire agent.offline for 'a' via the bus — registry's own handler picks it up.
    bus.emit({
      id: 'off',
      timestamp: new Date(),
      source: { type: 'core', id: 'agent-registry' },
      category: EventCategory.AgentOffline,
      data: { agentId: 'a' },
    })

    const downs = (h: typeof xH): number => h.mock.calls.filter((c) => c[0].state === 'down').length
    expect(downs(xH)).toBe(1)
    expect(downs(yH)).toBe(1)
    expect(downs(zH)).toBe(0) // different node
    expect(downs(wH)).toBe(0) // global not affected
    expect(reg.get('cap-x', { type: 'node', nodeId: 'a' })?.state).toBe('down')
    expect(reg.get('cap-z', { type: 'node', nodeId: 'b' })?.state).toBe('ready')
    reg.close()
  })

  it('skips caps already in down state (no duplicate transitions)', () => {
    const { bus, reg } = makeRegistry()
    reg.emitReady('cap-x', { type: 'node', nodeId: 'a' })
    reg.emitDown('cap-x', { type: 'node', nodeId: 'a' }) // pre-existing down
    const handler = vi.fn()
    reg.onReadyState('cap-x', { type: 'node', nodeId: 'a' }, handler)
    handler.mockClear() // ignore initial replay

    bus.emit({
      id: 'off',
      timestamp: new Date(),
      source: { type: 'core', id: 'agent-registry' },
      category: EventCategory.AgentOffline,
      data: { agentId: 'a' },
    })

    expect(handler).not.toHaveBeenCalled()
    reg.close()
  })

  it('preserves the last-known epoch + generation on synthesized down', () => {
    const { bus, reg } = makeRegistry()
    reg.emitReady('cap-x', { type: 'node', nodeId: 'a' })
    const record = reg.get('cap-x', { type: 'node', nodeId: 'a' })!

    bus.emit({
      id: 'off',
      timestamp: new Date(),
      source: { type: 'core', id: 'agent-registry' },
      category: EventCategory.AgentOffline,
      data: { agentId: 'a' },
    })

    const after = reg.get('cap-x', { type: 'node', nodeId: 'a' })!
    expect(after.state).toBe('down')
    expect(after.epoch).toBe(record.epoch)
    expect(after.generation).toBe(record.generation)
    reg.close()
  })
})
