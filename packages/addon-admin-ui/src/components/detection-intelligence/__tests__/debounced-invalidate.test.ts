import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDebouncedInvalidate } from '../debounced-invalidate.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createDebouncedInvalidate', () => {
  it('does not invalidate when nothing was triggered', () => {
    const invalidate = vi.fn()
    createDebouncedInvalidate({ delayMs: 2_000, invalidate })

    vi.advanceTimersByTime(10_000)

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('coalesces a burst (t=0, t=500, t=1500) into exactly one invalidate at t≈2000', () => {
    const invalidate = vi.fn()
    const debouncer = createDebouncedInvalidate({ delayMs: 2_000, invalidate })

    debouncer.trigger() // t=0 — opens the 2000ms window

    vi.advanceTimersByTime(500)
    debouncer.trigger() // t=500 — already pending, coalesced (does NOT extend the window)

    vi.advanceTimersByTime(1_000)
    debouncer.trigger() // t=1500 — still pending, coalesced

    expect(invalidate).not.toHaveBeenCalled()

    vi.advanceTimersByTime(499)
    expect(invalidate).not.toHaveBeenCalled() // t=1999 — not yet

    vi.advanceTimersByTime(1)
    expect(invalidate).toHaveBeenCalledTimes(1) // t=2000 — window closes, fires once
  })

  it('opens a fresh window for a later trigger and fires again at t≈+2000', () => {
    const invalidate = vi.fn()
    const debouncer = createDebouncedInvalidate({ delayMs: 2_000, invalidate })

    debouncer.trigger() // t=0
    vi.advanceTimersByTime(2_000)
    expect(invalidate).toHaveBeenCalledTimes(1) // t=2000 — first window fired

    vi.advanceTimersByTime(3_000) // idle until t=5000
    debouncer.trigger() // t=5000 — new window opens

    vi.advanceTimersByTime(1_999)
    expect(invalidate).toHaveBeenCalledTimes(1) // t=6999 — second window not yet closed

    vi.advanceTimersByTime(1)
    expect(invalidate).toHaveBeenCalledTimes(2) // t=7000 — second invalidate fires
  })

  it('cancel() clears a pending window so it never fires', () => {
    const invalidate = vi.fn()
    const debouncer = createDebouncedInvalidate({ delayMs: 2_000, invalidate })

    debouncer.trigger()
    vi.advanceTimersByTime(1_000)
    debouncer.cancel()
    vi.advanceTimersByTime(5_000)

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('cancel() is a no-op when nothing is pending', () => {
    const invalidate = vi.fn()
    const debouncer = createDebouncedInvalidate({ delayMs: 2_000, invalidate })

    expect(() => {
      debouncer.cancel()
    }).not.toThrow()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('a trigger after cancel() opens a fresh window', () => {
    const invalidate = vi.fn()
    const debouncer = createDebouncedInvalidate({ delayMs: 2_000, invalidate })

    debouncer.trigger()
    debouncer.cancel()

    debouncer.trigger()
    vi.advanceTimersByTime(2_000)

    expect(invalidate).toHaveBeenCalledTimes(1)
  })
})
