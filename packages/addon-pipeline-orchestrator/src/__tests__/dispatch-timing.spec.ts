/**
 * `raceBudget` — a wait that ends on time whether or not the promise did (D440).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { raceBudget } from '../dispatch-timing.js'

describe('raceBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles with the value when the promise beats the budget', async () => {
    const p = new Promise<string>((resolve) => setTimeout(() => resolve('census'), 100))
    const outcome = raceBudget(p, 500)
    await vi.advanceTimersByTimeAsync(100)
    expect(await outcome).toEqual({ kind: 'settled', value: 'census' })
  })

  it('reports budget-exceeded when the promise is still pending, and does not wait for it', async () => {
    let resolved = false
    const p = new Promise<void>((resolve) =>
      setTimeout(() => {
        resolved = true
        resolve()
      }, 5000),
    )
    const outcome = raceBudget(p, 500)
    await vi.advanceTimersByTimeAsync(500)
    expect(await outcome).toEqual({ kind: 'budget-exceeded' })
    expect(resolved).toBe(false)
  })

  it('reports a rejection as rejected, and an overrun rejection is not unhandled', async () => {
    const early = raceBudget(Promise.reject(new Error('runner gone')), 500)
    const outcome = await early
    expect(outcome.kind).toBe('rejected')

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const late = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('late failure')), 2000),
      )
      const overrun = raceBudget(late, 500)
      await vi.advanceTimersByTimeAsync(500)
      expect(await overrun).toEqual({ kind: 'budget-exceeded' })
      await vi.advanceTimersByTimeAsync(2000)
      await Promise.resolve()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
