/**
 * `ReadinessRegistry.hydrate()` — reconcile semantics (D8).
 *
 * 2026-07-17 incident: on `agent-a`, platform-probe COMPLETED its
 * probe and emitted `ready`, but the delta never reached the detection
 * runner child's registry (readiness events are telemetry — lossy). The
 * child's snapshot held `starting`; every later snapshot re-pull from the
 * parent was POWERLESS because `hydrate()` was add-only
 * (`if (this.snapshot.has(key)) continue`) — a key once observed could
 * never be advanced by an authoritative snapshot, so the waiter looped
 * "still awaiting platform-probe" forever.
 *
 * New contract: hydrate is a RECONCILE against an authoritative snapshot:
 *  - new keys: added exactly as before (epoch 1, one-shot dispatch);
 *  - existing keys: the authoritative record is APPLIED when its
 *    generation differs (producer restart / synthetic-down superseded),
 *    or when it is a FORWARD move within the same generation
 *    (starting → ready → down — a snapshot can only be ahead of a lost
 *    delta, never behind it, within one producer generation);
 *  - never a same-generation regress (a snapshot pulled just before a
 *    live delta landed must not un-ready a record);
 *  - never an update to a record THIS process is authoritative for
 *    (node-scoped to our own nodeId, or emitted by us) — an authority's
 *    stale copy of OUR record must not regress local truth.
 */
import { describe, expect, it } from 'vitest'
import type {
  EventFilter,
  IEventBus,
  ReadinessScope,
  SystemEvent,
} from '../../interfaces/event-bus.js'
import { emitReadiness } from '../../interfaces/event-bus.js'
import type { IReadinessRegistryRecord } from '../../interfaces/readiness.js'
import { ReadinessRegistry } from '../../readiness/readiness-registry.js'

/** Minimal synchronous in-memory bus (mirrors readiness-registry.spec.ts). */
class TestEventBus implements IEventBus {
  private subs: Array<{ filter: EventFilter; handler: (event: SystemEvent) => void }> = []
  emitted: SystemEvent[] = []

  emit(event: SystemEvent): void {
    this.emitted.push(event)
    for (const s of this.subs) {
      if (!s.filter.category || s.filter.category === event.category) s.handler(event)
    }
  }

  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void {
    const entry = { filter, handler }
    this.subs.push(entry)
    return () => {
      this.subs = this.subs.filter((s) => s !== entry)
    }
  }

  getRecent(): readonly SystemEvent[] {
    return []
  }
}

const NODE_SCOPE: ReadinessScope = { type: 'node', nodeId: 'agent-a' }

function record(partial: Partial<IReadinessRegistryRecord>): IReadinessRegistryRecord {
  return {
    capName: 'platform-probe',
    scope: NODE_SCOPE,
    state: 'ready',
    generation: 'gen-a',
    epoch: 1,
    lastChange: Date.now(),
    sourceNodeId: 'agent-a',
    ...partial,
  }
}

/** Registry as seen from a UDS child on the agent (composite nodeId). */
function makeChildRegistry(): { registry: ReadinessRegistry; bus: TestEventBus } {
  const bus = new TestEventBus()
  const registry = new ReadinessRegistry({
    eventBus: bus,
    sourceNodeId: 'agent-a/detection',
  })
  return { registry, bus }
}

describe('ReadinessRegistry.hydrate — reconcile semantics', () => {
  it('advances a stale starting record to ready within the SAME generation (the lost-delta wedge)', async () => {
    const { registry, bus } = makeChildRegistry()
    // Initial snapshot / early delta: probe still starting.
    emitReadiness(bus, {
      capName: 'platform-probe',
      scope: NODE_SCOPE,
      state: 'starting',
      generation: 'gen-a',
      sourceNodeId: 'agent-a',
    })
    expect(registry.get('platform-probe', NODE_SCOPE)?.state).toBe('starting')

    // A waiter is pending — exactly the wedged runner.
    const wait = registry.awaitReady('platform-probe', NODE_SCOPE, { timeoutMs: 1_000 })

    // The `ready` delta was LOST. A later authoritative snapshot re-pull
    // carries the truth — hydrate must apply it and unblock the waiter.
    registry.hydrate([record({ state: 'ready', generation: 'gen-a' })])

    await expect(wait).resolves.toBeUndefined()
    expect(registry.get('platform-probe', NODE_SCOPE)?.state).toBe('ready')
  })

  it('never regresses within the same generation (snapshot older than a live delta)', () => {
    const { registry, bus } = makeChildRegistry()
    emitReadiness(bus, {
      capName: 'platform-probe',
      scope: NODE_SCOPE,
      state: 'ready',
      generation: 'gen-a',
      sourceNodeId: 'agent-a',
    })

    registry.hydrate([record({ state: 'starting', generation: 'gen-a' })])

    expect(registry.get('platform-probe', NODE_SCOPE)?.state).toBe('ready')
  })

  it('applies a cross-generation ready over a synthesized down and bumps the epoch (agent restart recovery)', async () => {
    const { registry, bus } = makeChildRegistry()
    emitReadiness(bus, {
      capName: 'pipeline-executor',
      scope: NODE_SCOPE,
      state: 'ready',
      generation: 'gen-a',
      sourceNodeId: 'agent-a',
    })
    // Hub-synthesized down on disconnect (its own generation).
    emitReadiness(bus, {
      capName: 'pipeline-executor',
      scope: NODE_SCOPE,
      state: 'down',
      generation: 'disconnect-agent-a-xyz',
      sourceNodeId: 'hub',
    })
    const before = registry.get('pipeline-executor', NODE_SCOPE)
    expect(before?.state).toBe('down')

    const wait = registry.awaitReady('pipeline-executor', NODE_SCOPE, { timeoutMs: 1_000 })

    // The restarted producer's `ready` broadcast was lost; the snapshot
    // re-pull carries it with the NEW generation.
    registry.hydrate([
      record({ capName: 'pipeline-executor', state: 'ready', generation: 'gen-b' }),
    ])

    await expect(wait).resolves.toBeUndefined()
    const after = registry.get('pipeline-executor', NODE_SCOPE)
    expect(after?.state).toBe('ready')
    expect(after?.generation).toBe('gen-b')
    expect(after?.epoch).toBe((before?.epoch ?? 0) + 1)
  })

  it('never overwrites a record this process is authoritative for (node-scoped to own node)', () => {
    const bus = new TestEventBus()
    // Registry running ON the agent parent itself — it IS the origin of
    // node-scoped agent-a records.
    const registry = new ReadinessRegistry({ eventBus: bus, sourceNodeId: 'agent-a' })
    emitReadiness(bus, {
      capName: 'platform-probe',
      scope: NODE_SCOPE,
      state: 'ready',
      generation: 'gen-a',
      sourceNodeId: 'agent-a',
    })

    // A stale authority copy (e.g. the hub still believing `down`).
    registry.hydrate([record({ state: 'down', generation: 'disconnect-gen', sourceNodeId: 'hub' })])

    expect(registry.get('platform-probe', NODE_SCOPE)?.state).toBe('ready')
  })

  it('never overwrites a device-scoped record this process emitted', () => {
    const bus = new TestEventBus()
    const registry = new ReadinessRegistry({ eventBus: bus, sourceNodeId: 'agent-a' })
    const deviceScope: ReadinessScope = { type: 'device', deviceId: 104 }
    emitReadiness(bus, {
      capName: 'stream-broker',
      scope: deviceScope,
      state: 'ready',
      generation: 'gen-a',
      sourceNodeId: 'agent-a',
    })

    registry.hydrate([
      record({
        capName: 'stream-broker',
        scope: deviceScope,
        state: 'down',
        generation: 'other-gen',
        sourceNodeId: 'hub',
      }),
    ])

    expect(registry.get('stream-broker', deviceScope)?.state).toBe('ready')
  })

  it('keeps the add-path behaviour for unseen keys (epoch 1 + pending waiter unblocks)', async () => {
    const { registry } = makeChildRegistry()
    const wait = registry.awaitReady('platform-probe', NODE_SCOPE, { timeoutMs: 1_000 })

    registry.hydrate([record({ state: 'ready', generation: 'gen-a' })])

    await expect(wait).resolves.toBeUndefined()
    expect(registry.get('platform-probe', NODE_SCOPE)?.epoch).toBe(1)
  })

  it('is idempotent — re-hydrating the same record dispatches no duplicate transitions', () => {
    const { registry } = makeChildRegistry()
    const transitions: string[] = []
    registry.onReadyState('platform-probe', NODE_SCOPE, (t) => {
      transitions.push(`${t.state}:${t.generation}`)
    })

    const snap = [record({ state: 'ready', generation: 'gen-a' })]
    registry.hydrate(snap)
    registry.hydrate(snap)
    registry.hydrate(snap)

    expect(transitions.filter((t) => t === 'ready:gen-a')).toHaveLength(1)
  })
})
