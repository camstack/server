/**
 * The heartbeat ARMS the census (D444). Nobody is awake for an episode that
 * begins at 22:20 and releases at 23:38 with no line; the probe is.
 *
 * Disarms:
 *  - delete `judgeArrayBuffers(sample, at)` from `tick` → every test here red;
 *  - delete the `censusInFlight` guard → "never overlaps itself" red;
 *  - delete the `.catch` → "a census that fails says so" red (and the
 *    rejection escapes the watcher).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ARRAY_BUFFER_CENSUS_SUSTAIN_MS,
  ARRAY_BUFFER_CENSUS_THRESHOLD_MB,
  type ArrayBufferCensusReport,
} from '../array-buffer-census.js'
import {
  HEAP_WATCH_FAST_INTERVAL_MS,
  HEAP_WATCH_INTERVAL_MS,
  type LoopDelayMeter,
  startHeapWatch,
  ZERO_LOOP_DELAY,
} from '../heap-watch.js'

const MB = 1048576
const HEAP_LIMIT = 3264 * MB
const QUIET_LOOP: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: () => {} }

function mem(arrayBuffersMb: number): NodeJS.MemoryUsage {
  return {
    rss: 5000 * MB,
    heapUsed: 1500 * MB,
    heapTotal: 1600 * MB,
    external: (arrayBuffersMb + 500) * MB,
    arrayBuffers: arrayBuffersMb * MB,
  }
}

const REPORT: ArrayBufferCensusReport = {
  count: 68_000,
  bytes: 4_250 * MB,
  detached: 0,
  buckets: [{ upToBytes: 65_536, count: 68_000, bytes: 4_250 * MB }],
  topSizes: [{ byteLength: 65_536, count: 68_000, bytes: 4_250 * MB }],
}

interface Harness {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly census: ReturnType<typeof vi.fn>
  readonly setArrayBuffers: (mb: number) => void
  readonly advance: (ms: number) => Promise<void>
  readonly stop: () => void
}

function harness(census: ReturnType<typeof vi.fn>): Harness {
  vi.useFakeTimers()
  const info = vi.fn()
  const warn = vi.fn()
  let clock = 0
  let arrayBuffersMb = 20
  const stop = startHeapWatch(
    'hub-main',
    { info, warn },
    HEAP_WATCH_INTERVAL_MS,
    {
      reclaim: () => {},
      readMemory: () => mem(arrayBuffersMb),
      heapLimitBytes: HEAP_LIMIT,
      now: () => clock,
    },
    QUIET_LOOP,
    ['--max-old-space-size=3072'],
    false,
    undefined,
    { arrayBufferCensus: { census } },
  )
  return {
    info,
    warn,
    census,
    setArrayBuffers: (mb) => {
      arrayBuffersMb = mb
    },
    advance: async (ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed += HEAP_WATCH_FAST_INTERVAL_MS) {
        clock += HEAP_WATCH_FAST_INTERVAL_MS
        await vi.advanceTimersByTimeAsync(HEAP_WATCH_FAST_INTERVAL_MS)
      }
    },
    stop,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the heartbeat arms the ArrayBuffer census', () => {
  it('takes ONE census once the reading has held above the threshold for the sustain window, and the line carries the cost', async () => {
    const census = vi.fn(async () => REPORT)
    const h = harness(census)
    try {
      h.setArrayBuffers(ARRAY_BUFFER_CENSUS_THRESHOLD_MB + 200)
      await h.advance(ARRAY_BUFFER_CENSUS_SUSTAIN_MS - HEAP_WATCH_FAST_INTERVAL_MS)
      expect(census).not.toHaveBeenCalled()
      await h.advance(3 * HEAP_WATCH_FAST_INTERVAL_MS)
      expect(census).toHaveBeenCalledTimes(1)
      const line = h.warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('census'))
      expect(line).toBeDefined()
      expect(line).toContain('live=4250MB')
      expect(line).toContain(`raw arrayBuffers=${ARRAY_BUFFER_CENSUS_THRESHOLD_MB + 200}MB`)
      expect(line).toContain('ONE forced full GC')
      // Still above, inside the cooldown: no second census.
      await h.advance(5 * 60_000)
      expect(census).toHaveBeenCalledTimes(1)
    } finally {
      h.stop()
    }
  })

  it('a spike that lasts one probe never pays', async () => {
    const census = vi.fn(async () => REPORT)
    const h = harness(census)
    try {
      h.setArrayBuffers(1_300)
      await h.advance(HEAP_WATCH_FAST_INTERVAL_MS)
      h.setArrayBuffers(20)
      await h.advance(2 * ARRAY_BUFFER_CENSUS_SUSTAIN_MS)
      expect(census).not.toHaveBeenCalled()
    } finally {
      h.stop()
    }
  })

  it('logs a RELEASE when a sustained live set vanishes between two probes — the boundary that had no line', async () => {
    const census = vi.fn(async () => REPORT)
    const h = harness(census)
    try {
      h.setArrayBuffers(4_968)
      await h.advance(ARRAY_BUFFER_CENSUS_SUSTAIN_MS + 2 * HEAP_WATCH_FAST_INTERVAL_MS)
      h.setArrayBuffers(47)
      await h.advance(HEAP_WATCH_FAST_INTERVAL_MS)
      const line = h.warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('RELEASED'))
      expect(line).toContain('arrayBuffers RELEASED 4968MB→47MB')
    } finally {
      h.stop()
    }
  })

  it('never overlaps itself: a census still running is not started again', async () => {
    let resolveFirst: ((r: ArrayBufferCensusReport) => void) | null = null
    const census = vi.fn(
      () =>
        new Promise<ArrayBufferCensusReport>((resolve) => {
          resolveFirst = resolve
        }),
    )
    const h = harness(census)
    try {
      h.setArrayBuffers(2_000)
      await h.advance(ARRAY_BUFFER_CENSUS_SUSTAIN_MS + 2 * HEAP_WATCH_FAST_INTERVAL_MS)
      expect(census).toHaveBeenCalledTimes(1)
      await h.advance(40 * 60_000)
      expect(census).toHaveBeenCalledTimes(1)
      resolveFirst!(REPORT)
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      h.stop()
    }
  })

  it('a census that fails says so, and the watcher keeps ticking', async () => {
    const census = vi.fn(async () => {
      throw new Error('inspector refused')
    })
    const h = harness(census)
    try {
      h.setArrayBuffers(2_000)
      await h.advance(ARRAY_BUFFER_CENSUS_SUSTAIN_MS + 2 * HEAP_WATCH_FAST_INTERVAL_MS)
      const line = h.warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('FAILED'))
      expect(line).toContain('arrayBuffer census FAILED')
      expect(line).toContain('inspector refused')
      const before = h.info.mock.calls.filter((c) => String(c[0]).includes('rss=')).length
      await h.advance(HEAP_WATCH_INTERVAL_MS + HEAP_WATCH_FAST_INTERVAL_MS)
      const after = h.info.mock.calls.filter((c) => String(c[0]).includes('rss=')).length
      expect(after).toBeGreaterThan(before)
    } finally {
      h.stop()
    }
  })
})
