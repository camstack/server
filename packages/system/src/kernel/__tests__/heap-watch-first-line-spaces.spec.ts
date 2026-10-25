/**
 * The FIRST `[mem]` line after boot names every V8 space (D867).
 *
 * The routine line prints the decisive pair plus any space over 32 MB, which is
 * right for a minute-by-minute heartbeat and wrong for the one question the
 * boot floor asks ("where do the first 415 MB sit?"): the space that holds it
 * may be one the filter hides. Later lines revert to the filtered set; the GC
 * trigger flags ride the same line as the rate.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GcObservation, NodeGcObserver } from '../gc-census.js'
import { type HeapWatchSink, startHeapWatch } from '../heap-watch.js'

const MB = 1048576
const MEM: NodeJS.MemoryUsage = {
  rss: 600 * MB,
  heapTotal: 300 * MB,
  heapUsed: 200 * MB,
  external: 50 * MB,
  arrayBuffers: 20 * MB,
}

const SPACES = [
  { name: 'old_space', usedBytes: 150 * MB },
  { name: 'large_object_space', usedBytes: 0 },
  { name: 'new_space', usedBytes: 3 * MB },
  { name: 'code_space', usedBytes: 2 * MB },
  { name: 'trusted_space', usedBytes: 1 * MB },
]

function lines(): { sink: HeapWatchSink; lines: string[] } {
  const out: string[] = []
  return {
    lines: out,
    sink: {
      info: (m: string): void => {
        out.push(m)
      },
      warn: (m: string): void => {
        out.push(m)
      },
    },
  }
}

function run(
  gcObserver: NodeGcObserver | undefined,
  drive: (advance: (ms: number) => void) => void,
): string[] {
  vi.useFakeTimers()
  try {
    let at = 0
    const l = lines()
    const stop = startHeapWatch(
      'pipeline-analytics',
      l.sink,
      60_000,
      {
        readMemory: () => MEM,
        now: () => at,
        heapLimitBytes: 3_422_552_064,
        reclaim: () => undefined,
      },
      undefined,
      [],
      false,
      undefined,
      { readSpaces: () => SPACES, ...(gcObserver !== undefined ? { gcObserver } : {}) },
    )
    drive((ms) => {
      at += ms
      vi.advanceTimersByTime(ms)
    })
    stop()
    return l.lines.filter((m) => m.startsWith('[mem] pipeline-analytics rss='))
  } finally {
    vi.useRealTimers()
  }
}

describe('first [mem] line after boot — every V8 space (D867)', () => {
  it('prints the small spaces on the first line only', () => {
    const memLines = run(undefined, (advance) => {
      advance(60_000)
      advance(60_000)
    })
    expect(memLines.length).toBeGreaterThanOrEqual(2)
    const [first, second] = memLines
    for (const field of ['oldSpace=150MB', 'newSpace=3MB', 'codeSpace=2MB', 'trustedSpace=1MB']) {
      expect(first).toContain(field)
    }
    // Routine lines are filtered again: the decisive pair, nothing under 32 MB.
    expect(second).toContain('oldSpace=150MB')
    expect(second).toContain('largeObjectSpace=0MB')
    expect(second).not.toContain('newSpace=')
    expect(second).not.toContain('codeSpace=')
  })

  it('carries the GC trigger flag names beside the rate', () => {
    let emit: ((entry: GcObservation) => void) | null = null
    const observer: NodeGcObserver = {
      kinds: { major: 4, minor: 1, incremental: 8 },
      flagBits: [{ name: 'ALL_EXTERNAL_MEMORY', bit: 32 }],
      install: (observe): (() => void) => {
        emit = observe
        return (): void => {
          emit = null
        }
      },
    }
    const memLines = run(observer, (advance) => {
      emit?.({ kind: 4, durationMs: 100, flags: 32 })
      emit?.({ kind: 4, durationMs: 100, flags: 32 })
      advance(60_000)
    })
    expect(memLines.some((m) => m.includes('gcFlags=ALL_EXTERNAL_MEMORY:2'))).toBe(true)
  })
})
