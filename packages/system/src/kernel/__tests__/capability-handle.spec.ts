/**
 * Unit tests for `CapabilityHandle` and `CapabilityUnavailableError`.
 *
 * Uses a real `ReadinessRegistry` with a minimal synchronous TestEventBus
 * so tests are deterministic without relying on Moleculer or fake timers
 * except where timeout behaviour is explicitly under test.
 */
import { describe, it, expect, vi } from 'vitest'
import type {
  IEventBus,
  SystemEvent,
  EventFilter,
  KnownEventCategory,
  TypedSystemEvent,
  TypedEventFilter,
  ReadinessScope,
} from '@camstack/types'
import { ReadinessRegistry } from '@camstack/types'
import { CapabilityHandle, CapabilityUnavailableError } from '../capability-handle.js'

// ── Test helpers ──────────────────────────────────────────────────────

/**
 * Minimal synchronous in-memory bus — good enough for unit tests.
 * Delivers events in the same tick so assertions can run without
 * needing fake timers or microtask flushes (except where the registry
 * itself uses queueMicrotask for onReadyState initial replay).
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

function makeRegistry(): { bus: TestEventBus; reg: ReadinessRegistry } {
  const bus = new TestEventBus()
  const reg = new ReadinessRegistry({ eventBus: bus, sourceNodeId: 'hub' })
  return { bus, reg }
}

const globalScope: ReadinessScope = { type: 'global' }

// ── State machine tests ───────────────────────────────────────────────

describe('CapabilityHandle — state machine', () => {
  it('starts pending when no snapshot exists — isReady is false after construction', () => {
    const { reg } = makeRegistry()
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      expect(handle.isReady).toBe(false)
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('starts ready when cap already in registry before construction', async () => {
    const { reg } = makeRegistry()
    reg.emitReady('my-cap', globalScope)
    // Let the registry event settle — ingest is synchronous so no await needed
    // but the snapshot is set synchronously via bus.emit → ingest.
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      expect(handle.isReady).toBe(true)
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('starts down when cap already down before construction', async () => {
    const { reg } = makeRegistry()
    reg.emitReady('my-cap', globalScope)
    reg.emitDown('my-cap', globalScope)
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      expect(handle.isReady).toBe(false)
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('pending → ready: isReady becomes true after emitReady', async () => {
    const { reg } = makeRegistry()
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      expect(handle.isReady).toBe(false)
      reg.emitReady('my-cap', globalScope)
      // onReadyState fires via queueMicrotask — flush the microtask queue
      await Promise.resolve()
      expect(handle.isReady).toBe(true)
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('ready → down: isReady becomes false after emitDown', async () => {
    const { reg } = makeRegistry()
    reg.emitReady('my-cap', globalScope)
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    // The constructor seeds from the snapshot (synchronous), so isReady is already true.
    expect(handle.isReady).toBe(true)
    // Flush the microtask queue first so the deferred initial-replay from
    // onReadyState (which fires via queueMicrotask) completes before we emit
    // down. Without this flush the replay could race the down transition and
    // reset state to 'ready' after the down.
    await Promise.resolve()
    try {
      reg.emitDown('my-cap', globalScope)
      await Promise.resolve()
      expect(handle.isReady).toBe(false)
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('down → ready: full cycle, isReady is true again after second emitReady', async () => {
    const { reg } = makeRegistry()
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      reg.emitReady('my-cap', globalScope)
      await Promise.resolve()
      expect(handle.isReady).toBe(true)

      reg.emitDown('my-cap', globalScope)
      await Promise.resolve()
      expect(handle.isReady).toBe(false)

      reg.emitReady('my-cap', globalScope)
      await Promise.resolve()
      expect(handle.isReady).toBe(true)
    } finally {
      handle.dispose()
      reg.close()
    }
  })
})

// ── awaitReady tests ──────────────────────────────────────────────────

describe('CapabilityHandle — awaitReady', () => {
  it('resolves immediately when already ready', async () => {
    const { reg } = makeRegistry()
    reg.emitReady('my-cap', globalScope)
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      await expect(handle.awaitReady(5_000)).resolves.toBeUndefined()
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('resolves when ready arrives within timeout', async () => {
    const { reg } = makeRegistry()
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      const awaitPromise = handle.awaitReady(500)
      // Emit ready shortly after
      reg.emitReady('my-cap', globalScope)
      await expect(awaitPromise).resolves.toBeUndefined()
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('throws CapabilityUnavailableError on timeout', async () => {
    vi.useFakeTimers()
    const { reg } = makeRegistry()
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      // Attach the catch handler BEFORE advancing timers so the rejection is
      // handled on the same tick it is created — avoids PromiseRejectionHandledWarning.
      let caught: unknown
      const awaitPromise = handle.awaitReady(50).catch((err) => {
        caught = err
      })
      // Advance fake timers past the 50ms timeout
      await vi.advanceTimersByTimeAsync(100)
      await awaitPromise
      expect(caught).toBeInstanceOf(CapabilityUnavailableError)
      const unavailable = caught as CapabilityUnavailableError
      expect(unavailable.capName).toBe('my-cap')
      expect(unavailable.scope).toEqual(globalScope)
      expect(unavailable.timeoutMs).toBe(50)
    } finally {
      handle.dispose()
      reg.close()
      vi.useRealTimers()
    }
  })

  it('does not call registry awaitReady when already ready', async () => {
    const { reg } = makeRegistry()
    reg.emitReady('my-cap', globalScope)
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    const awaitReadySpy = vi.spyOn(reg, 'awaitReady')
    try {
      await handle.awaitReady(5_000)
      // Should resolve immediately without delegating to registry.awaitReady
      expect(awaitReadySpy).not.toHaveBeenCalled()
    } finally {
      awaitReadySpy.mockRestore()
      handle.dispose()
      reg.close()
    }
  })
})

// ── call() tests ──────────────────────────────────────────────────────

describe('CapabilityHandle — call()', () => {
  it('executes fn and returns its result when already ready', async () => {
    const { reg } = makeRegistry()
    reg.emitReady('my-cap', globalScope)
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      const result = await handle.call(async () => 42)
      expect(result).toBe(42)
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('gates fn until ready — fn not called immediately, called after emitReady', async () => {
    const { reg } = makeRegistry()
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    let fnCalled = false
    const fn = vi.fn(async () => {
      fnCalled = true
      return 'done'
    })
    try {
      const callPromise = handle.call(fn)
      // fn should NOT have been called yet (cap is still pending)
      expect(fnCalled).toBe(false)
      expect(fn).not.toHaveBeenCalled()

      // Now emit ready to unblock
      reg.emitReady('my-cap', globalScope)
      const result = await callPromise
      expect(result).toBe('done')
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('propagates fn error when fn throws', async () => {
    const { reg } = makeRegistry()
    reg.emitReady('my-cap', globalScope)
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    const boom = new Error('fn exploded')
    try {
      await expect(
        handle.call(async () => {
          throw boom
        }),
      ).rejects.toThrow('fn exploded')
    } finally {
      handle.dispose()
      reg.close()
    }
  })

  it('throws CapabilityUnavailableError when cap never becomes ready within call timeout', async () => {
    vi.useFakeTimers()
    const { reg } = makeRegistry()
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    const fn = vi.fn(async () => 'should not be called')
    try {
      // Attach catch BEFORE advancing timers to avoid PromiseRejectionHandledWarning.
      let caught: unknown
      const callPromise = handle.call(fn, 50).catch((err) => {
        caught = err
      })
      await vi.advanceTimersByTimeAsync(100)
      await callPromise
      expect(caught).toBeInstanceOf(CapabilityUnavailableError)
      expect(fn).not.toHaveBeenCalled()
    } finally {
      handle.dispose()
      reg.close()
      vi.useRealTimers()
    }
  })
})

// ── dispose() tests ───────────────────────────────────────────────────

describe('CapabilityHandle — dispose()', () => {
  it('stops receiving state updates after dispose', async () => {
    const { reg } = makeRegistry()
    const handle = new CapabilityHandle('my-cap', globalScope, reg, 5_000)
    try {
      // Emit ready before dispose so handle is in 'ready' state
      reg.emitReady('my-cap', globalScope)
      await Promise.resolve()
      expect(handle.isReady).toBe(true)

      // Dispose — unsubscribes from the registry
      handle.dispose()

      // Emit down after dispose — handle should NOT update (still 'ready')
      reg.emitDown('my-cap', globalScope)
      await Promise.resolve()
      expect(handle.isReady).toBe(true) // unchanged after dispose
    } finally {
      reg.close()
    }
  })
})

// ── CapabilityUnavailableError tests ─────────────────────────────────

describe('CapabilityUnavailableError', () => {
  it('carries capName, scope, timeoutMs and correct name', () => {
    const scope: ReadinessScope = { type: 'node', nodeId: 'worker-1' }
    const err = new CapabilityUnavailableError('stream-broker', scope, 3_000)
    expect(err.name).toBe('CapabilityUnavailableError')
    expect(err.capName).toBe('stream-broker')
    expect(err.scope).toBe(scope)
    expect(err.timeoutMs).toBe(3_000)
    expect(err.message).toContain('stream-broker')
    expect(err.message).toContain('3000ms')
  })

  it('is an instance of Error', () => {
    const err = new CapabilityUnavailableError('cap', globalScope, 100)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CapabilityUnavailableError)
  })
})
