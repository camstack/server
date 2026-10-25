import { describe, expect, it, vi } from 'vitest'
import {
  attributeStall,
  startEventLoopStallMonitor,
  STALL_REPORT_MS,
} from '../event-loop-stall-monitor.js'

/**
 * The verdict is the whole point of the module: from outside the process a GC
 * pause and a synchronous block look identical, and the 2026-08-01 fleet stall
 * cannot be fixed until they are told apart.
 */
describe('attributing a freeze', () => {
  it('a stall that is mostly GC reads as gc', () => {
    expect(attributeStall(40_000, 38_000, 12, 9_000).cause).toBe('gc')
  })

  it('a stall with almost no GC reads as a synchronous block', () => {
    // The important verdict: it points AWAY from the heap, so nobody spends a
    // session tuning GC flags for a stall garbage collection never caused.
    expect(attributeStall(40_000, 200, 1, 200).cause).toBe('synchronous-block')
  })

  it('a genuinely mixed stall is not forced into either bucket', () => {
    expect(attributeStall(10_000, 4_000, 5, 1_200).cause).toBe('mixed')
  })

  it('a zero-length stall never divides by zero', () => {
    expect(attributeStall(0, 0, 0, 0).cause).toBe('synchronous-block')
  })
})

describe('the monitor', () => {
  it('stays silent while ticks are on time, and reports once a freeze happens', () => {
    vi.useFakeTimers()
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => logger,
    }
    const stop = startEventLoopStallMonitor(logger as never)
    try {
      // Punctual ticks: nothing to say.
      vi.advanceTimersByTime(5_000)
      expect(logger.warn).not.toHaveBeenCalled()

      // A freeze. `advanceTimersByTime` moves the clock and the timer in
      // lockstep, so it can never produce lateness — that is what a blocked
      // loop actually is. Jump the SYSTEM clock forward with the timer still
      // parked, then let one tick run: it arrives 45s after it was due.
      vi.setSystemTime(Date.now() + 45_000)
      vi.advanceTimersByTime(1_000)
      const call = logger.warn.mock.calls.find(
        (c: readonly unknown[]) => c[0] === 'event loop stalled',
      )
      expect(call).toBeDefined()
      const meta = (call?.[1] as { meta?: Record<string, unknown> } | undefined)?.meta
      expect(Number(meta?.['stallMs'])).toBeGreaterThanOrEqual(STALL_REPORT_MS)
      // Heap numbers ride along — the follow-up question is always "growing?".
      expect(meta).toHaveProperty('heapUsedMb')
      expect(meta).toHaveProperty('rssMb')
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('stop() is idempotent — a double stop must not throw', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => logger,
    }
    const stop = startEventLoopStallMonitor(logger as never)
    stop()
    expect(() => stop()).not.toThrow()
  })
})
