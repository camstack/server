/**
 * The reclaim gate measures what a GC can hand back (D393 for the fallback).
 *
 * sqlite-settings, measured on the hub: VmRSS 1079 = RssAnon 585 + RssFile 493.
 * The file-backed half is mmap'd SQLite pages the kernel reclaims on its own;
 * counting it fired 45 useless reclaims in a day (freed 190 MB, heapUsed 62→55).
 */
import { describe, expect, it, vi } from 'vitest'
import { createAnonRssReader, parseAnonRssBytes } from '../anon-rss.js'
import {
  buildHeapSample,
  HEAP_WATCH_FAST_INTERVAL_MS,
  type LoopDelayMeter,
  RECLAIM_STEADY_STATE_PASSES,
  shouldReclaim,
  startHeapWatch,
  strandedMb,
  ZERO_LOOP_DELAY,
} from '../heap-watch.js'

const MB = 1048576
const LIMIT = 4288 * MB
const QUIET_LOOP: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: () => {} }

function mem(over: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  return {
    rss: 1079 * MB,
    heapUsed: 62 * MB,
    heapTotal: 90 * MB,
    external: 20 * MB,
    arrayBuffers: 5 * MB,
    ...over,
  } as NodeJS.MemoryUsage
}
// A sqlite-settings whose file-backed pages put VmRSS over the trigger.
const SQLITE = mem({ rss: 1500 * MB })

describe('strandedMb uses RssAnon when it is known', () => {
  it('file-backed pages do not count as stranded', () => {
    const withAnon = buildHeapSample(SQLITE, LIMIT, undefined, 585 * MB)
    expect(strandedMb(withAnon)).toBe(585 - 62 - 20)
    expect(shouldReclaim(withAnon)).toBe(false)
  })

  it('falls back to rss when RssAnon is unmeasured, and that fires the old gate', () => {
    const without = buildHeapSample(SQLITE, LIMIT)
    expect(strandedMb(without)).toBe(1500 - 62 - 20)
    expect(shouldReclaim(without)).toBe(true)
  })
})

describe('the anon reader', () => {
  it('parses RssAnon out of /proc/self/status', () => {
    expect(
      parseAnonRssBytes('VmRSS:\t 1105920 kB\nRssAnon:\t 599040 kB\nRssFile:\t 505344 kB\n'),
    ).toBe(599040 * 1024)
  })

  it('a failed read is undefined (never 0) and warns once', () => {
    const warn = vi.fn()
    const read = createAnonRssReader(warn, 'linux', () => {
      throw new Error('EACCES')
    })
    expect(read()).toBeUndefined()
    expect(read()).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('is not consulted on macOS or Windows', () => {
    const readStatus = vi.fn(() => 'RssAnon: 1 kB')
    for (const platform of ['darwin', 'win32'] as const) {
      expect(createAnonRssReader(vi.fn(), platform, readStatus)()).toBeUndefined()
    }
    expect(readStatus).not.toHaveBeenCalled()
  })
})

describe('the gate no longer degenerates into a fixed-cadence timer', () => {
  function passesOver(durationMs: number, anon: number | undefined): number {
    vi.useFakeTimers()
    let clock = 0
    let passes = 0
    const stop = startHeapWatch(
      'sqlite-settings',
      { info: () => {}, warn: () => {} },
      60_000,
      {
        reclaim: () => {
          passes += 1
        },
        readMemory: () => SQLITE,
        readAnonRssBytes: () => (anon === undefined ? undefined : anon * MB),
        heapLimitBytes: LIMIT,
        now: () => clock,
      },
      QUIET_LOOP,
      ['--max-old-space-size=1024'],
      false,
    )
    try {
      for (let t = 0; t < durationMs; t += HEAP_WATCH_FAST_INTERVAL_MS) {
        clock += HEAP_WATCH_FAST_INTERVAL_MS
        vi.advanceTimersByTime(HEAP_WATCH_FAST_INTERVAL_MS)
      }
    } finally {
      stop()
      vi.useRealTimers()
    }
    return passes
  }

  it('honest number: zero passes in an hour', () => {
    expect(passesOver(3_600_000, 585)).toBe(0)
  })

  it('VmRSS fallback: fires every floor period (the old timer)', () => {
    // 120 s floor for the first RECLAIM_STEADY_STATE_PASSES, then the backed-off period.
    expect(passesOver(3_600_000, undefined)).toBeGreaterThanOrEqual(RECLAIM_STEADY_STATE_PASSES)
  })
})
