/**
 * The reclaim line already measured the live set. It printed everything else.
 *
 * `heap-watch.ts:1026` reads a full `process.memoryUsage()` into `after`
 * IMMEDIATELY after the synchronous compacting `gc({ flavor: 'last-resort' })`.
 * That `after.heapUsed` is the live set at t+0 — what survives a full
 * compaction — and it is the only clean read of it obtainable without a heap
 * snapshot. The line printed `rss` and `arrayBuffers` from both readings and
 * dropped it.
 *
 * The cost of dropping it, measured: on 2026-08-29 the recorder's live set had
 * to be argued from a heartbeat **40 seconds** after the pass
 * (`docs/design/2026-08-29-recorder-heap-what-is-retained.md` §1.2), and at the
 * implied allocation rate those 40 seconds are ~70 MB of slack that every
 * reader since has had to argue about.
 *
 * Two things are asserted, and they are different claims:
 *
 *  1. the pair is printed, and the second number is read AFTER the pass — a
 *     line that printed the pre-reclaim reading twice would be worse than
 *     silence, because it would look like an answer;
 *  2. every field that was on this line before keeps its name AND its position.
 *     The Loki queries written on 2026-08-29 match this prefix.
 */
import { describe, expect, it, vi } from 'vitest'
import { HEAP_WATCH_FAST_INTERVAL_MS, startHeapWatch } from '../heap-watch.js'
import { ZERO_LOOP_DELAY, type LoopDelayMeter } from '../heap-watch.js'

const MB = 1048576
const HEAP_LIMIT = 4288 * MB
const QUIET_LOOP: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: () => {} }

function mem(over: Partial<NodeJS.MemoryUsage>): NodeJS.MemoryUsage {
  return {
    rss: 0,
    heapUsed: 0,
    heapTotal: 0,
    external: 0,
    arrayBuffers: 0,
    ...over,
  } as NodeJS.MemoryUsage
}

/**
 * `hub/recorder`'s only reclaim of 2026-08-29, verbatim:
 *
 *   10:10:45Z reclaim stranded=1029MB rss=2478MB→1971MB freed=507MB
 *             arrayBuffers=0MB→0MB took=1005ms
 *
 * with the number the line did not carry: 1439 MB of live JS heap before the
 * pass and, in this fixture, 1400 MB after it.
 */
const BEFORE = mem({ rss: 2478 * MB, heapUsed: 1439 * MB, heapTotal: 1870 * MB, external: 10 * MB })
const AFTER = mem({ rss: 1971 * MB, heapUsed: 1400 * MB, heapTotal: 1870 * MB, external: 10 * MB })

/** Run one reclaim on a stranded process and return the line it printed. */
function reclaimOnce(): string {
  vi.useFakeTimers()
  const info: string[] = []
  let reclaimed = false
  let clock = 0
  const stop = startHeapWatch(
    'hub/recorder',
    { info: (l) => info.push(l), warn: () => {} },
    300_000,
    {
      reclaim: () => {
        reclaimed = true
      },
      readMemory: () => (reclaimed ? AFTER : BEFORE),
      heapLimitBytes: HEAP_LIMIT,
      now: () => clock,
    },
    QUIET_LOOP,
    ['--max-old-space-size=3072'],
    false,
  )
  try {
    clock += HEAP_WATCH_FAST_INTERVAL_MS
    vi.advanceTimersByTime(HEAP_WATCH_FAST_INTERVAL_MS)
  } finally {
    stop()
    vi.useRealTimers()
  }
  const line = info.find((l) => l.startsWith('[mem] reclaim '))
  expect(line).toBeDefined()
  return line ?? ''
}

describe('the reclaim reports the live set at t+0', () => {
  it('prints heapUsed before AND after the compacting pass', () => {
    // 1439 is the reading handed to `shouldReclaim`; 1400 exists only in the
    // read taken after `reclaim()` ran. A line built from `sample` alone can
    // never produce the second number, which is what makes this disarm-proof.
    expect(reclaimOnce()).toContain('heapUsed=1439MB→1400MB')
  })

  it('the second number comes from the post-pass read, not a repeat of the first', () => {
    const line = reclaimOnce()
    expect(line).not.toContain('heapUsed=1439MB→1439MB')
    // And the arrow is a PAIR, not a level: a single `heapUsed=1400MB` would
    // leave the reader unable to say what the pass freed.
    expect(/heapUsed=\d+MB→\d+MB/.test(line)).toBe(true)
  })

  it('names the process, so the number can be asked per runner', () => {
    expect(reclaimOnce()).toContain('[mem] reclaim hub/recorder ')
  })
})

describe('every field that was already on this line keeps its name and position', () => {
  it('matches the exact prefix the 2026-08-29 Loki queries were written against', () => {
    // Deliberately anchored and ordered. This assertion must pass with the new
    // field present and with it removed — it guards the PREFIX, not the
    // addition — which is why the two claims are in separate blocks.
    expect(reclaimOnce()).toMatch(
      /^\[mem\] reclaim hub\/recorder stranded=1029MB rss=2478MB→1971MB freed=507MB arrayBuffers=0MB→0MB took=\d+ms/,
    )
  })

  it('appends the new field after `took`, never between two existing ones', () => {
    const line = reclaimOnce()
    expect(line.indexOf('heapUsed=')).toBeGreaterThan(line.indexOf('took='))
  })
})
