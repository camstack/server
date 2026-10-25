/**
 * The GC census is the half of the GC's cost the `[mem]` line never carried:
 * the RATE. D443/D444/D446/D456 each read a level, and none of them could say
 * whether hub-main's 70 % of CPU came from the size of the live set or from the
 * frequency of the collection — until the count was measured (1.39 majors/s
 * against 22 MB/s of old-space growth: external pressure, not a filling heap).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createGcCensus,
  formatGcCensus,
  GC_CENSUS_MIN_WINDOW_MS,
  type GcCensusWindow,
  type GcKinds,
  type GcObservation,
  nodeGcObserver,
} from '../gc-census.js'

const KINDS: GcKinds = { major: 4, minor: 1, incremental: 8 }

interface Harness {
  readonly emit: (entry: GcObservation) => void
  readonly stopped: () => number
  readonly install: (observe: (entry: GcObservation) => void) => (() => void) | undefined
}

function harness(refuse = false): Harness {
  let sink: ((entry: GcObservation) => void) | null = null
  let stops = 0
  return {
    emit: (entry): void => sink?.(entry),
    stopped: (): number => stops,
    install: (observe): (() => void) | undefined => {
      if (refuse) return undefined
      sink = observe
      return (): void => {
        stops++
        sink = null
      }
    },
  }
}

const major = (ms: number): GcObservation => ({ kind: KINDS.major, durationMs: ms })
const minor = (ms: number): GcObservation => ({ kind: KINDS.minor, durationMs: ms })
const incremental = (ms: number): GcObservation => ({ kind: KINDS.incremental, durationMs: ms })

describe('counting collections', () => {
  it('counts each kind and the main-thread pause across the window', () => {
    const h = harness()
    const census = createGcCensus(h.install, KINDS, 1_000)
    expect(census).toBeDefined()
    h.emit(major(150))
    h.emit(minor(5))
    h.emit(minor(6))
    h.emit(incremental(1))
    expect(census?.read(61_000)).toEqual<GcCensusWindow>({
      majors: 1,
      minors: 2,
      incrementals: 1,
      pauseMs: 162,
      windowMs: 60_000,
    })
  })

  it('describes the window since the previous read, never the lifetime', () => {
    const h = harness()
    const census = createGcCensus(h.install, KINDS, 0)
    h.emit(major(10))
    expect(census?.read(60_000)?.majors).toBe(1)
    h.emit(major(10))
    h.emit(major(10))
    const second = census?.read(120_000)
    expect(second?.majors).toBe(2)
    expect(second?.windowMs).toBe(60_000)
  })

  it('reports a window with no collections — silence is a reading, not an absence', () => {
    const h = harness()
    const census = createGcCensus(h.install, KINDS, 0)
    expect(census?.read(60_000)).toEqual<GcCensusWindow>({
      majors: 0,
      minors: 0,
      incrementals: 0,
      pauseMs: 0,
      windowMs: 60_000,
    })
    expect(formatGcCensus(census?.read(120_000))).toContain('gc=maj0/min0/inc0')
  })

  it('is UNDEFINED when no observer can be installed — never a census of zero', () => {
    const census = createGcCensus(harness(true).install, KINDS, 0)
    expect(census).toBeUndefined()
    expect(formatGcCensus(undefined)).toBe('')
    expect(formatGcCensus(null)).toBe('')
  })

  it('counts an unrecognised kind in the pause but in none of the three buckets', () => {
    const h = harness()
    const census = createGcCensus(h.install, KINDS, 0)
    h.emit({ kind: 16, durationMs: 3 })
    const w = census?.read(60_000)
    expect([w?.majors, w?.minors, w?.incrementals]).toEqual([0, 0, 0])
    expect(w?.pauseMs).toBe(3)
  })

  it('stops observing when stopped, and drops what had not been read', () => {
    const h = harness()
    const census = createGcCensus(h.install, KINDS, 0)
    h.emit(major(10))
    census?.stop()
    expect(h.stopped()).toBe(1)
    h.emit(major(10))
    expect(census?.read(60_000)?.majors).toBe(0)
  })

  it('refuses a window shorter than the floor — a rate over no time is not a number', () => {
    const h = harness()
    const census = createGcCensus(h.install, KINDS, 5_000)
    expect(census?.read(5_000)).toBeNull()
    expect(census?.read(4_000)).toBeNull()
    expect(census?.read(5_000 + GC_CENSUS_MIN_WINDOW_MS - 1)).toBeNull()
    // A refused read does not consume the window: the collections it could not
    // describe are still there for the read that can.
    h.emit(major(7))
    expect(census?.read(5_000 + GC_CENSUS_MIN_WINDOW_MS)?.majors).toBe(1)
  })
})

describe('the line', () => {
  it('carries the counts, the window and the per-minute major rate', () => {
    const text = formatGcCensus({
      majors: 83,
      minors: 106,
      incrementals: 80,
      pauseMs: 1288.4,
      windowMs: 60_000,
    })
    expect(text).toBe(' gc=maj83/min106/inc80@60s gcMajPerMin=83.0 gcPauseMs=1288')
  })

  it('leads with a space and adds nothing else, so it APPENDS to the line (D446 field order)', () => {
    const text = formatGcCensus({
      majors: 1,
      minors: 1,
      incrementals: 0,
      pauseMs: 1,
      windowMs: 120_000,
    })
    expect(text.startsWith(' ')).toBe(true)
    expect(text.trimStart().split(' ')[0]?.startsWith('gc=')).toBe(true)
    expect(text).toContain('gcMajPerMin=0.5')
  })
})

describe('the real observer', () => {
  it('reads the kind constants from Node rather than hard-coding them', async () => {
    const perf = await import('node:perf_hooks')
    expect(nodeGcObserver().kinds).toEqual({
      major: perf.constants.NODE_PERFORMANCE_GC_MAJOR,
      minor: perf.constants.NODE_PERFORMANCE_GC_MINOR,
      incremental: perf.constants.NODE_PERFORMANCE_GC_INCREMENTAL,
    })
  })

  it('observes a real collection and hands back a stop that disconnects', async () => {
    const observer = nodeGcObserver()
    const seen: GcObservation[] = []
    const stop = observer.install((e) => seen.push(e))
    expect(stop).toBeDefined()
    // Provoke collections without --expose-gc: churn enough short-lived
    // objects that the scavenger has to run. A fixed count is used rather than
    // a timeout so the test cannot pass by waiting.
    for (let i = 0; i < 60; i++) {
      const junk: unknown[] = []
      for (let j = 0; j < 20_000; j++) junk.push({ i, j, pad: `${i}-${j}` })
      if (junk.length === 0) throw new Error('unreachable')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((e) => e.durationMs >= 0)).toBe(true)
    stop?.()
    const after = seen.length
    for (let i = 0; i < 20; i++) {
      const junk: unknown[] = []
      for (let j = 0; j < 20_000; j++) junk.push({ i, j, pad: `${i}-${j}` })
      if (junk.length === 0) throw new Error('unreachable')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(seen.length).toBe(after)
  })

  it('declines rather than throwing when the runtime has no gc entry type', () => {
    const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => {
      throw new Error('no perf_hooks here')
    })
    try {
      expect(nodeGcObserver().install(() => undefined)).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('trigger flags (D867)', () => {
  const FLAG_BITS = [
    { name: 'FORCED', bit: 4 },
    { name: 'ALL_EXTERNAL_MEMORY', bit: 32 },
  ]

  it('counts each cycle under the NAME of every flag it carried', () => {
    const h = harness()
    const census = createGcCensus(h.install, KINDS, 0, FLAG_BITS)
    h.emit({ ...major(100), flags: 32 })
    h.emit({ ...major(100), flags: 32 | 4 })
    h.emit({ ...minor(2), flags: 0 })
    h.emit(minor(2))
    expect(census?.read(60_000)?.flags).toEqual({ ALL_EXTERNAL_MEMORY: 2, FORCED: 1 })
  })

  it('prints them on the line, most frequent first, and nothing when no cycle carried one', () => {
    const withFlags: GcCensusWindow = {
      majors: 2,
      minors: 0,
      incrementals: 0,
      pauseMs: 10,
      windowMs: 60_000,
      flags: { FORCED: 1, ALL_EXTERNAL_MEMORY: 5 },
    }
    expect(formatGcCensus(withFlags)).toContain(' gcFlags=ALL_EXTERNAL_MEMORY:5,FORCED:1')
    expect(formatGcCensus({ ...withFlags, flags: undefined })).not.toContain('gcFlags')
    expect(formatGcCensus({ ...withFlags, flags: {} })).not.toContain('gcFlags')
  })

  it('the real observer names the flags Node defines (ALL_EXTERNAL_MEMORY among them)', () => {
    const names = (nodeGcObserver().flagBits ?? []).map((f) => f.name)
    expect(names).toContain('ALL_EXTERNAL_MEMORY')
  })
})
