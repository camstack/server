import { describe, expect, it, vi } from 'vitest'
import { KeyedAsyncLock } from '../keyed-async-lock.js'

/**
 * Unit coverage for the generic `KeyedAsyncLock` extracted from the
 * byte-for-byte-duplicated `withAudioSubLock`/`withSessionLock` critical
 * sections (S2 refactor). `audio-sub-lock.spec.ts` remains the end-to-end
 * regression net for `withAudioSubLock`'s rewire onto this class; these
 * tests exercise the lock in isolation.
 */

/** Resolver-bearing deferred so a test can control interleaving. */
interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('KeyedAsyncLock', () => {
  it('serializes sections queued for the SAME key (FIFO order)', async () => {
    const lock = new KeyedAsyncLock<number>({ isShuttingDown: () => false })
    const order: number[] = []

    const gate1 = deferred()
    const c1 = lock.run(1, async () => {
      await gate1.promise
      order.push(1)
    })
    const c2 = lock.run(1, async () => {
      order.push(2)
    })
    const c3 = lock.run(1, async () => {
      order.push(3)
    })

    // 2 and 3 must not jump ahead of the still-gated 1.
    expect(order).toEqual([])
    gate1.resolve()
    await Promise.all([c1, c2, c3])
    expect(order).toEqual([1, 2, 3])
  })

  it('does NOT serialize sections for DIFFERENT keys — they run independently', async () => {
    const lock = new KeyedAsyncLock<number>({ isShuttingDown: () => false })
    const startedB = vi.fn()
    const gateA = deferred()

    // Key 1 blocks on gateA (never released until key 2 has already finished).
    const callA = lock.run(1, async () => {
      await gateA.promise
    })
    const callB = lock.run(2, async () => {
      startedB()
    })

    await callB
    expect(startedB).toHaveBeenCalledTimes(1)

    gateA.resolve()
    await callA
  })

  it('a throwing section rejects its own promise but does not wedge the chain', async () => {
    const lock = new KeyedAsyncLock<number>({ isShuttingDown: () => false })

    const boom = lock.run(1, async () => {
      throw new Error('section failed')
    })
    await expect(boom).rejects.toThrow('section failed')

    const ran = vi.fn()
    await lock.run(1, async () => {
      ran()
    })
    expect(ran).toHaveBeenCalledTimes(1)
  })

  it('is a no-op once isShuttingDown() returns true — queued sections never run', async () => {
    let shuttingDown = false
    const lock = new KeyedAsyncLock<number>({ isShuttingDown: () => shuttingDown })

    shuttingDown = true
    const ran = vi.fn()
    await lock.run(1, async () => {
      ran()
    })
    expect(ran).not.toHaveBeenCalled()
  })

  it('a section already in flight when shutdown begins still resolves as a no-op on its next turn', async () => {
    let shuttingDown = false
    const lock = new KeyedAsyncLock<number>({ isShuttingDown: () => shuttingDown })
    const started = deferred()
    const gate = deferred()
    const ran = vi.fn()

    const call = lock.run(1, async () => {
      started.resolve()
      await gate.promise
      ran()
    })
    await started.promise
    // Shutdown flips while the section is queued behind nothing (already
    // running) — this call itself already committed to running `fn`, mirroring
    // the production semantics: the flag is only checked once per turn.
    shuttingDown = true
    gate.resolve()
    await call
    // The in-flight section DOES complete (flag is checked once, at the
    // start of the turn) — it's the NEXT queued section that becomes a no-op.
    expect(ran).toHaveBeenCalledTimes(1)

    const ranNext = vi.fn()
    await lock.run(1, async () => {
      ranNext()
    })
    expect(ranNext).not.toHaveBeenCalled()
  })

  it('drains the tail entry once a key fully settles (size returns to 0)', async () => {
    const lock = new KeyedAsyncLock<number>({ isShuttingDown: () => false })
    await lock.run(1, async () => undefined)
    await lock.run(2, async () => undefined)
    // Flush the full microtask/event-loop queue so the internal drain (which
    // chains one more `.then` after the caller-facing promise) has settled.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(lock.size).toBe(0)
  })

  it('clear() drops all queued tails', async () => {
    const lock = new KeyedAsyncLock<number>({ isShuttingDown: () => false })
    const gate = deferred()
    void lock.run(1, async () => {
      await gate.promise
    })
    expect(lock.size).toBe(1)
    lock.clear()
    expect(lock.size).toBe(0)
    gate.resolve()
  })
})
