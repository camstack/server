/**
 * The GC rate on the heartbeat line.
 *
 * The `[mem]` line has carried the live set since 2026-08-29 and never the
 * rate, and that is why D443, D444, D446 and D456 could each read hub-main's
 * memory and none of them could say whether its 70 % of CPU came from the size
 * of the live set or from the frequency of the collection. These tests pin the
 * field's presence, its window, and the D446 order — nothing before it moves.
 */
import { describe, expect, it, vi } from 'vitest'
import { startHeapWatch, type HeapWatchSink } from '../heap-watch.js'
import type { GcObservation, NodeGcObserver } from '../gc-census.js'

const KINDS = { major: 4, minor: 1, incremental: 8 }

interface Sink extends HeapWatchSink {
  readonly lines: readonly string[]
}

function sink(): Sink {
  const lines: string[] = []
  return {
    lines,
    info: (m: string): void => {
      lines.push(m)
    },
    warn: (m: string): void => {
      lines.push(m)
    },
  }
}

interface Observer {
  readonly probe: NodeGcObserver
  readonly emit: (entry: GcObservation) => void
  readonly disconnected: () => number
}

function observer(refuse = false): Observer {
  let out: ((entry: GcObservation) => void) | null = null
  let disconnected = 0
  return {
    emit: (entry): void => out?.(entry),
    disconnected: (): number => disconnected,
    probe: {
      kinds: KINDS,
      install: (observe): (() => void) | undefined => {
        if (refuse) return undefined
        out = observe
        return (): void => {
          disconnected++
          out = null
        }
      },
    },
  }
}

const MEM: NodeJS.MemoryUsage = {
  rss: 2_400_000_000,
  heapTotal: 1_000_000_000,
  heapUsed: 800_000_000,
  external: 270_000_000,
  arrayBuffers: 20_000_000,
}

function watchWith(o: Observer, s: Sink, clock: () => number): () => void {
  return startHeapWatch(
    'hub-main',
    s,
    60_000,
    { readMemory: () => MEM, now: clock, heapLimitBytes: 3_422_552_064, reclaim: () => undefined },
    undefined,
    [],
    false,
    undefined,
    { gcObserver: o.probe, readSpaces: () => [] },
  )
}

describe('the gc census on the [mem] line', () => {
  it('appends the counts, the window and the major rate — and appends them LAST', () => {
    vi.useFakeTimers()
    try {
      let at = 1_000_000
      const o = observer()
      const s = sink()
      const stop = watchWith(o, s, () => at)
      o.emit({ kind: KINDS.major, durationMs: 160 })
      o.emit({ kind: KINDS.major, durationMs: 140 })
      o.emit({ kind: KINDS.minor, durationMs: 5 })
      at += 60_000
      vi.advanceTimersByTime(60_000)
      stop()
      const line = s.lines.find((l) => l.includes('gc=maj'))
      expect(line).toBeDefined()
      expect(line).toContain('gc=maj2/min1/inc0@60s')
      expect(line).toContain('gcMajPerMin=2.0')
      expect(line).toContain('gcPauseMs=305')
      // D446: appended last. Every older field keeps its position.
      expect(line?.indexOf('heapUsed=')).toBeLessThan(line?.indexOf('gc=maj') ?? -1)
      expect(line?.indexOf('loopP99=')).toBeLessThan(line?.indexOf('gc=maj') ?? -1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('describes the LINE’s window, not the 2 s probe that ran 30 times inside it', () => {
    vi.useFakeTimers()
    try {
      let at = 0
      const o = observer()
      const s = sink()
      const stop = watchWith(o, s, () => at)
      for (let i = 0; i < 30; i++) {
        o.emit({ kind: KINDS.major, durationMs: 10 })
        at += 2_000
        vi.advanceTimersByTime(2_000)
      }
      stop()
      const lines = s.lines.filter((l) => l.includes('gc=maj'))
      // One line at boot (empty window) plus one when the minute is due.
      const due = lines.at(-1)
      expect(due).toContain('@60s')
      expect(due).toContain('gc=maj30/')
    } finally {
      vi.useRealTimers()
    }
  })

  it('prints NOTHING about the gc when no observer can be installed — never a census of zero', () => {
    vi.useFakeTimers()
    try {
      let at = 0
      const s = sink()
      const stop = watchWith(observer(true), s, () => at)
      at += 60_000
      vi.advanceTimersByTime(60_000)
      stop()
      expect(s.lines.length).toBeGreaterThan(0)
      expect(s.lines.some((l) => l.includes('gc='))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('disconnects the observer when the watch stops', () => {
    vi.useFakeTimers()
    try {
      const o = observer()
      const stop = watchWith(o, sink(), () => 0)
      expect(o.disconnected()).toBe(0)
      stop()
      expect(o.disconnected()).toBe(1)
      stop()
      expect(o.disconnected()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
