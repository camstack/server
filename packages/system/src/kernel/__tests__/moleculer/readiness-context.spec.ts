/**
 * readiness-context — unit tests for Task D2.
 *
 * Verifies that `getOrInitReadinessRegistry` can operate in UDS-only mode
 * (when a `LocalChildClient` is provided instead of a Moleculer broker):
 *
 *   1. The registry hydrates from `client.requestReadinessSnapshot()` once
 *      connected (the `client.isConnected` flag is true after start).
 *   2. `awaitReady` resolves when a `system.ready-state` 'ready' delta
 *      arrives via the event bus — same semantics as broker mode.
 *   3. The snapshot-then-subscribe ordering is preserved: a cap already
 *      'ready' in the hydrated snapshot resolves `awaitReady` immediately.
 *   4. Re-pull on reconnect: if the client is re-connected (post-disconnect
 *      restart scenario), a second `requestReadinessSnapshot` is issued.
 *   5. Broker path is unaffected — existing broker-mode callers still work.
 *   6. `awaitReady` default is Infinity (no timeout = never rejects from
 *      timeout alone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  IReadinessRegistryRecord,
  IEventBus,
  IScopedLogger,
  SystemEvent,
} from '@camstack/types'
import { getOrInitReadinessRegistryForClient } from '../../moleculer/readiness-context.js'

// ---------------------------------------------------------------------------
// Fake IEventBus backed by a simple subscriber map
// ---------------------------------------------------------------------------

type EventHandler = (event: SystemEvent) => void

function createFakeEventBus(): IEventBus & { emit: (event: SystemEvent) => void } {
  const subscribers = new Map<string, EventHandler[]>()

  return {
    emit(event: SystemEvent): void {
      const handlers = subscribers.get(event.category) ?? []
      for (const h of handlers) h(event)
      const wildcard = subscribers.get('*') ?? []
      for (const h of wildcard) h(event)
    },
    subscribe(filter: { category: string }, handler: EventHandler): () => void {
      const key = filter.category
      const list = subscribers.get(key) ?? []
      list.push(handler)
      subscribers.set(key, list)
      return () => {
        const l = subscribers.get(key) ?? []
        const idx = l.indexOf(handler)
        if (idx >= 0) l.splice(idx, 1)
      }
    },
    getRecent(): SystemEvent[] {
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// Fake LocalChildClient (minimal surface used by readiness-context)
// ---------------------------------------------------------------------------

interface FakeLocalChildClient {
  readonly isConnected: boolean
  requestReadinessSnapshot: () => Promise<readonly IReadinessRegistryRecord[]>
  onConnected: (cb: () => void) => void
}

function createFakeClient(
  snapshot: readonly IReadinessRegistryRecord[] = [],
): FakeLocalChildClient & { triggerConnected: () => void } {
  let connected = false
  let connectedCb: (() => void) | null = null

  return {
    get isConnected() {
      return connected
    },
    requestReadinessSnapshot: vi.fn(() => Promise.resolve(snapshot)),
    onConnected(cb: () => void) {
      connectedCb = cb
    },
    triggerConnected() {
      connected = true
      connectedCb?.()
    },
  }
}

// ---------------------------------------------------------------------------
// Fake scoped logger (silent)
// ---------------------------------------------------------------------------

const silentLogger: IScopedLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
  withTags: () => silentLogger,
}

// ---------------------------------------------------------------------------
// Helper: build a SystemEvent for ready-state
// ---------------------------------------------------------------------------

function makeReadyEvent(capName: string, nodeId: string = 'hub'): SystemEvent {
  return {
    id: `evt-${capName}`,
    timestamp: new Date(),
    category: 'system.ready-state',
    source: { type: 'capability', id: capName, nodeId },
    data: {
      capName,
      scope: { type: 'global' },
      state: 'ready',
      generation: 'gen-test',
      sourceNodeId: nodeId,
      ts: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('D2 — getOrInitReadinessRegistryForClient (UDS mode)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes a registry with awaitReady + hydrate surface', () => {
    const bus = createFakeEventBus()
    const client = createFakeClient()

    const registry = getOrInitReadinessRegistryForClient(client, bus, silentLogger, 'runner-1')

    expect(registry).toBeDefined()
    expect(typeof registry.awaitReady).toBe('function')
    expect(typeof registry.hydrate).toBe('function')
    expect(typeof registry.getSnapshotForTransport).toBe('function')
  })

  it('requests the snapshot once the client is connected', async () => {
    const snapshot: IReadinessRegistryRecord[] = [
      {
        capName: 'pipeline-executor',
        scope: { type: 'global' },
        state: 'ready',
        generation: 'gen-pe',
        epoch: 1,
        lastChange: 1_000,
        sourceNodeId: 'hub',
      },
    ]
    const bus = createFakeEventBus()
    const client = createFakeClient(snapshot)

    getOrInitReadinessRegistryForClient(client, bus, silentLogger, 'runner-2')

    // Before connect: snapshot not yet pulled
    expect(client.requestReadinessSnapshot).not.toHaveBeenCalled()

    // Trigger connect
    client.triggerConnected()
    await Promise.resolve() // microtask flush

    expect(client.requestReadinessSnapshot).toHaveBeenCalledOnce()
  })

  it('awaitReady resolves immediately for a cap already in the hydrated snapshot', async () => {
    const snapshot: IReadinessRegistryRecord[] = [
      {
        capName: 'stream-broker',
        scope: { type: 'global' },
        state: 'ready',
        generation: 'gen-sb',
        epoch: 1,
        lastChange: 2_000,
        sourceNodeId: 'hub',
      },
    ]
    const bus = createFakeEventBus()
    const client = createFakeClient(snapshot)

    const registry = getOrInitReadinessRegistryForClient(client, bus, silentLogger, 'runner-3')

    // Trigger connect so snapshot is hydrated
    client.triggerConnected()
    await Promise.resolve() // let requestReadinessSnapshot resolve
    await Promise.resolve() // let hydrate callbacks run

    await expect(
      registry.awaitReady('stream-broker', { type: 'global' }, { timeoutMs: 500 }),
    ).resolves.toBeUndefined()
  })

  it('awaitReady resolves when a system.ready-state delta arrives via event bus', async () => {
    const bus = createFakeEventBus()
    const client = createFakeClient() // empty snapshot

    const registry = getOrInitReadinessRegistryForClient(client, bus, silentLogger, 'runner-4')

    client.triggerConnected()
    await Promise.resolve()

    const readyPromise = registry.awaitReady(
      'motion-detector',
      { type: 'global' },
      { timeoutMs: 1_000 },
    )

    // Emit a ready event on the bus — same as Phase C UDS event delivery
    bus.emit(makeReadyEvent('motion-detector'))

    await expect(readyPromise).resolves.toBeUndefined()
  })

  it('snapshot-then-subscribe ordering: existing ready caps unblock awaitReady without a new event', async () => {
    const snapshot: IReadinessRegistryRecord[] = [
      {
        capName: 'decoder',
        scope: { type: 'global' },
        state: 'ready',
        generation: 'gen-d',
        epoch: 1,
        lastChange: 3_000,
        sourceNodeId: 'hub',
      },
    ]
    const bus = createFakeEventBus()
    const client = createFakeClient(snapshot)

    const registry = getOrInitReadinessRegistryForClient(client, bus, silentLogger, 'runner-5')

    client.triggerConnected()
    // Flush the two async steps: (1) requestReadinessSnapshot resolution, (2) hydrate notification
    await Promise.resolve()
    await Promise.resolve()

    // awaitReady created AFTER hydration should still see the snapshot
    await expect(
      registry.awaitReady('decoder', { type: 'global' }, { timeoutMs: 500 }),
    ).resolves.toBeUndefined()
  })

  it('re-pull snapshot on reconnect (second triggerConnected)', async () => {
    const bus = createFakeEventBus()
    const client = createFakeClient()

    getOrInitReadinessRegistryForClient(client, bus, silentLogger, 'runner-6')

    client.triggerConnected()
    await Promise.resolve()
    expect(client.requestReadinessSnapshot).toHaveBeenCalledTimes(1)

    // Simulate a reconnect signal
    client.triggerConnected()
    await Promise.resolve()
    expect(client.requestReadinessSnapshot).toHaveBeenCalledTimes(2)
  })

  it('awaitReady default is Infinity — resolves only when ready, not on timeout', async () => {
    const bus = createFakeEventBus()
    const client = createFakeClient()

    const registry = getOrInitReadinessRegistryForClient(client, bus, silentLogger, 'runner-7')
    client.triggerConnected()
    await Promise.resolve()

    // Start an infinite awaitReady — should NOT time out on its own
    let resolved = false
    const p = registry.awaitReady('never-ready', { type: 'global' }).then(() => {
      resolved = true
    })

    // Wait a tick — still pending
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    // Now emit ready
    bus.emit(makeReadyEvent('never-ready'))
    await p
    expect(resolved).toBe(true)
  })
})

describe('periodic authoritative re-pull (D8 reconcile — lost-delta repair)', () => {
  // 2026-07-17 incident: platform-probe on the agent completed and emitted
  // `ready`, but the delta never reached the detection runner child; the
  // child's registry held `starting` forever because snapshots were pulled
  // ONLY on (re)connect. The registry must periodically re-pull the
  // parent's authoritative snapshot while connected, so a lost delta
  // delays convergence by one reconcile round — never forever.
  it('re-pulls the parent snapshot on the reconcile interval and advances a stale record', async () => {
    vi.useFakeTimers()
    try {
      const scope = { type: 'node', nodeId: 'agent-a' } as const
      let snapshot: IReadinessRegistryRecord[] = [
        {
          capName: 'platform-probe',
          scope,
          state: 'starting',
          generation: 'gen-a',
          epoch: 0,
          lastChange: 1_000,
          sourceNodeId: 'agent-a',
        },
      ]
      let connected = false
      // Defaults to a no-op rather than `null`: this fake is driven from the
      // SAME scope it is declared in, so control-flow analysis would narrow a
      // `null` initializer to `never` at the call below (the assignment happens
      // inside `onConnected`). `createFakeClient` above keeps the nullable form
      // because it fires from a nested method.
      let connectedCb: () => void = () => {
        /* registry has not subscribed yet */
      }
      const pull = vi.fn(() => Promise.resolve<readonly IReadinessRegistryRecord[]>(snapshot))
      const client = {
        get isConnected() {
          return connected
        },
        requestReadinessSnapshot: pull,
        onConnected(cb: () => void) {
          connectedCb = cb
        },
      }
      const bus = createFakeEventBus()
      const registry = getOrInitReadinessRegistryForClient(
        client,
        bus,
        silentLogger,
        'agent-a/detection-periodic',
      )
      connected = true
      connectedCb()
      await vi.advanceTimersByTimeAsync(0)
      expect(pull).toHaveBeenCalledTimes(1)
      expect(registry.get('platform-probe', scope)?.state).toBe('starting')

      // The probe completes; its `ready` delta is LOST. Only the parent's
      // authoritative snapshot carries the truth now.
      snapshot = [
        {
          capName: 'platform-probe',
          scope,
          state: 'ready',
          generation: 'gen-a',
          epoch: 1,
          lastChange: 2_000,
          sourceNodeId: 'agent-a',
        },
      ]
      await vi.advanceTimersByTimeAsync(61_000)
      expect(pull.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(registry.get('platform-probe', scope)?.state).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not pull while the client is disconnected', async () => {
    vi.useFakeTimers()
    try {
      const pull = vi.fn(() => Promise.resolve<readonly IReadinessRegistryRecord[]>([]))
      const client = {
        get isConnected() {
          return false
        },
        requestReadinessSnapshot: pull,
        onConnected(_cb: () => void) {},
      }
      const bus = createFakeEventBus()
      getOrInitReadinessRegistryForClient(client, bus, silentLogger, 'runner-periodic-offline')

      await vi.advanceTimersByTimeAsync(180_000)
      expect(pull).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
