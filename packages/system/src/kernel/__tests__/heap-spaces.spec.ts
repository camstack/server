/**
 * The per-space breakdown — the free half of the read that names a retained set.
 *
 * Every fixture here is a LIVE reading. The recorder numbers are from
 * `docs/design/2026-08-29-recorder-heap-what-is-retained.md` (1439 MB live after
 * a forced compacting GC, against 115–125 MB anyone could price); the quiet
 * shape is a bare Node 24.17 process; the 52 MB control is the same addon build
 * running as `recorder` on an agent with no cameras and no archive. A threshold
 * that does not separate those states is the wrong threshold.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DECISIVE_HEAP_SPACES,
  emitHeapDiagnosticReport,
  formatHeapSpaces,
  HEAP_SPACE_REPORT_MIN_MB,
  type HeapDiagnosticDeps,
  heapSpaceField,
  type HeapSpaceUsage,
  readHeapSpaces,
  selectReportedSpaces,
} from '../heap-spaces.js'
import {
  HEAP_WATCH_INTERVAL_MS,
  type LoopDelayMeter,
  startHeapWatch,
  ZERO_LOOP_DELAY,
} from '../heap-watch.js'

const MB = 1048576

function space(name: string, mb: number): HeapSpaceUsage {
  return { name, usedBytes: Math.round(mb * MB) }
}

/** A bare Node 24.17 process, measured. Nothing here is a retained set. */
const QUIET: readonly HeapSpaceUsage[] = [
  space('read_only_space', 0),
  space('new_space', 0.7),
  space('old_space', 3.1),
  space('code_space', 0.25),
  space('shared_space', 0),
  space('trusted_space', 0.9),
  space('new_large_object_space', 0),
  space('large_object_space', 0.25),
  space('code_large_object_space', 0),
  space('shared_large_object_space', 0),
]

/** Hypothesis (a): millions of small objects. */
const MANY_SMALL: readonly HeapSpaceUsage[] = [
  space('new_space', 8),
  space('old_space', 1401),
  space('code_space', 3),
  space('trusted_space', 12),
  space('large_object_space', 21),
]

/** Hypothesis (b): a handful of objects over V8's ~128KB regular ceiling. */
const FEW_HUGE: readonly HeapSpaceUsage[] = [
  space('new_space', 8),
  space('old_space', 74),
  space('code_space', 3),
  space('trusted_space', 12),
  space('large_object_space', 1348),
]

describe('which spaces earn a field, and which never will', () => {
  it('prints the decisive pair ALWAYS — including at zero', () => {
    // `largeObjectSpace=0MB` is a reading, not a blank: it says the retainer is
    // NOT a handful of huge objects. A threshold-only rule would drop it and a
    // reader could not tell "small" from "this build does not report it" — the
    // same class of mistake as a heartbeat with no destination (D285).
    const line = formatHeapSpaces([space('old_space', 3.1), space('large_object_space', 0)])
    expect(line).toBe(' oldSpace=3MB largeObjectSpace=0MB')
  })

  it('a quiet process prints NOTHING but the decisive pair', () => {
    // Ten of the thirteen spaces Node 24 reports are under a megabyte on an
    // idle process. Printing them would add ten fields to every [mem] line on
    // every runner in the fleet, forever, to say nothing.
    expect(formatHeapSpaces(QUIET)).toBe(' oldSpace=3MB largeObjectSpace=0MB')
  })

  it('the threshold sits BELOW the smallest heap this line must explain', () => {
    // The control in the 2026-08-29 pass is an idle `recorder` runner at 52MB
    // of heapUsed. A threshold at or above that could hide a space that is the
    // whole of a small process.
    expect(HEAP_SPACE_REPORT_MIN_MB).toBeLessThan(52)
  })

  it('a non-decisive space that gets big is NOT censored', () => {
    // Nothing is on a deny-list. `new_large_object_space` is where a huge object
    // lands BEFORE it is promoted — measured on Node 24.17, a single 16M-element
    // array put 122MB there — so a process caught mid-cycle must still be able
    // to say where its bytes are.
    const line = formatHeapSpaces([
      space('old_space', 74),
      space('large_object_space', 40),
      space('new_large_object_space', 122),
      space('trusted_space', 12),
    ])
    expect(line).toBe(' oldSpace=74MB largeObjectSpace=40MB newLargeObjectSpace=122MB')
    expect(line).not.toContain('trustedSpace')
  })

  it('the tail is largest-first, because the tail only appears when something is wrong', () => {
    const selected = selectReportedSpaces([
      space('old_space', 100),
      space('large_object_space', 5),
      space('code_space', 40),
      space('new_space', 90),
      space('trusted_space', 60),
    ])
    expect(selected.map((s) => s.name)).toEqual([
      'old_space',
      'large_object_space',
      'new_space',
      'trusted_space',
      'code_space',
    ])
  })

  it('a reading V8 declined to give prints no fields, never an `undefined`', () => {
    // `readHeapSpaces` swallows a throw into an empty reading. A heartbeat that
    // could not read the heap must say nothing about it, not print a hole.
    expect(formatHeapSpaces([])).toBe('')
  })

  it("uses V8's own names, mechanically camelCased into this line's vocabulary", () => {
    // Mechanical and total, so a space V8 adds tomorrow gets a field without
    // anyone editing a table. camelCase because every other field on this line
    // is camelCase — `heapUsed=` beside `old_space=` would be two conventions
    // for one record.
    expect(heapSpaceField('old_space')).toBe('oldSpace')
    expect(heapSpaceField('large_object_space')).toBe('largeObjectSpace')
    expect(heapSpaceField('shared_trusted_large_object_space')).toBe(
      'sharedTrustedLargeObjectSpace',
    )
    expect(DECISIVE_HEAP_SPACES).toEqual(['old_space', 'large_object_space'])
  })
})

describe('the breakdown answers the question the heap snapshot was going to be asked', () => {
  it('millions of small objects: old_space holds it and large_object_space says it is not huge', () => {
    expect(formatHeapSpaces(MANY_SMALL)).toBe(' oldSpace=1401MB largeObjectSpace=21MB')
  })

  it('a handful of huge objects: the same two fields say the opposite', () => {
    expect(formatHeapSpaces(FEW_HUGE)).toBe(' oldSpace=74MB largeObjectSpace=1348MB')
  })

  it('the two hypotheses are distinguishable from the LINE ALONE', () => {
    // The whole point. These two readings have the same heapUsed and lead to
    // completely different searches; before this field the log could not tell
    // them apart and only a heap snapshot could.
    expect(formatHeapSpaces(MANY_SMALL)).not.toBe(formatHeapSpaces(FEW_HUGE))
  })
})

const HUB_HEAP_LIMIT = 4288 * MB

function mem(over: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  return {
    rss: 1988 * MB,
    heapUsed: 1439 * MB,
    heapTotal: 1870 * MB,
    external: 5 * MB,
    arrayBuffers: 2 * MB,
    ...over,
  } as NodeJS.MemoryUsage
}

/**
 * The `[mem]` line exactly as it read BEFORE this change, for the recorder
 * sample at 10:11:25Z. Every query written against the old line is a query
 * against this prefix.
 */
const LINE_BEFORE =
  '[mem] hub/recorder rss=1988MB heapUsed=1439MB heapTotal=1870MB heapLimit=4288MB ' +
  'used=34% external=5MB arrayBuffers=2MB'

/** A loop that has not turned. `undefined` would take the real meter's default. */
const QUIET_LOOP: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: () => {} }

/** …and what those zeros add to the line, unchanged by this work. */
const LOOP_FIELDS = ' loopP50=0ms loopP99=0ms loopMax=0ms'

function firstSample(readSpaces: () => readonly HeapSpaceUsage[]): string {
  const info = vi.fn()
  const warn = vi.fn()
  const stop = startHeapWatch(
    'hub/recorder',
    { info, warn },
    HEAP_WATCH_INTERVAL_MS,
    { readMemory: () => mem(), heapLimitBytes: HUB_HEAP_LIMIT, reclaim: vi.fn() },
    QUIET_LOOP,
    ['--max-old-space-size=3072'],
    false,
    undefined,
    { readSpaces },
  )
  stop()
  const lines = [...info.mock.calls, ...warn.mock.calls]
    .map((c) => String(c[0]))
    .filter((l) => l.includes('rss='))
  expect(lines).toHaveLength(1)
  return lines[0] ?? ''
}

describe('the heartbeat carries it, and nothing already on the line moves', () => {
  it('every existing field keeps its NAME and its POSITION — the breakdown is appended', () => {
    // A rename or a reorder is the one change to a log format that silently
    // breaks every `hl loki-query` pipeline written against it. Prefix
    // stability is the only guarantee that cannot.
    // D867: the FIRST line after boot names every space (min 0 MB); later lines
    // are filtered again — see heap-watch-first-line-spaces.spec.ts.
    const line = firstSample(() => MANY_SMALL)
    expect(line.startsWith(LINE_BEFORE)).toBe(true)
    expect(line).toBe(
      `${LINE_BEFORE}${LOOP_FIELDS} oldSpace=1401MB largeObjectSpace=21MB trustedSpace=12MB newSpace=8MB codeSpace=3MB`,
    )
  })

  it('comes after the loop percentiles when there is a meter', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch(
      'hub/recorder',
      { info, warn },
      HEAP_WATCH_INTERVAL_MS,
      { readMemory: () => mem(), heapLimitBytes: HUB_HEAP_LIMIT, reclaim: vi.fn() },
      { read: () => ({ p50Ms: 2, p99Ms: 24, maxMs: 2804 }), stop: vi.fn() },
      ['--max-old-space-size=3072'],
      false,
      undefined,
      { readSpaces: () => MANY_SMALL },
    )
    stop()
    const line = String(info.mock.calls[0]?.[0] ?? '')
    expect(line).toBe(
      `${LINE_BEFORE} loopP50=2ms loopP99=24ms loopMax=2804ms ` +
        `oldSpace=1401MB largeObjectSpace=21MB trustedSpace=12MB newSpace=8MB codeSpace=3MB`,
    )
  })

  it('rides the WARN line too — near the ceiling is exactly when the shape matters', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch(
      'hub/recorder',
      { info, warn },
      HEAP_WATCH_INTERVAL_MS,
      {
        readMemory: () => mem({ heapUsed: 3900 * MB }),
        heapLimitBytes: HUB_HEAP_LIMIT,
        reclaim: vi.fn(),
      },
      undefined,
      ['--max-old-space-size=3072'],
      false,
      undefined,
      { readSpaces: () => MANY_SMALL },
    )
    stop()
    const line = String(warn.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('APPROACHING HEAP LIMIT')
    expect(line).toContain('oldSpace=1401MB largeObjectSpace=21MB')
  })

  it('a heap it could not read leaves the line exactly as it was', () => {
    expect(firstSample(() => [])).toBe(`${LINE_BEFORE}${LOOP_FIELDS}`)
  })
})

describe('against the real V8, not a fixture', () => {
  it('attributes a huge object to a large-object space and a crowd of small ones to old_space', () => {
    const read = (name: string): number =>
      (readHeapSpaces().find((s) => s.name === name)?.usedBytes ?? 0) / MB
    const largeMb = (): number => read('large_object_space') + read('new_large_object_space')

    const oldBefore = read('old_space')
    const largeBefore = largeMb()
    // One object, ~122MB measured on Node 24.17 — far over the ~128KB ceiling
    // for a regular heap object, so V8 has nowhere to put it but a large-object
    // space (new_large_object_space until it is promoted).
    // `Array.from({ length: n })` is the lint-preferred spelling and the wrong
    // tool here: it runs 16M iterations to build the same backing store this
    // needs in one allocation, and the test is about WHERE V8 puts the store.
    // oxlint-disable-next-line no-new-array
    const huge = new Array(16_000_000).fill(7)
    expect(huge.length).toBe(16_000_000)
    const oldAfterHuge = read('old_space')
    const largeAfterHuge = largeMb()
    expect(largeAfterHuge - largeBefore).toBeGreaterThan(64)
    expect(oldAfterHuge - oldBefore).toBeLessThan(16)

    // ...and the opposite shape, measured the same way: 800k small retained
    // objects land in old_space and barely touch the large-object spaces.
    const crowd: { readonly i: number; readonly s: string }[] = []
    for (let i = 0; i < 800_000; i += 1) crowd.push({ i, s: `k${i}` })
    expect(crowd.length).toBe(800_000)
    const oldGrowth = read('old_space') - oldAfterHuge
    const largeGrowth = largeMb() - largeAfterHuge
    expect(oldGrowth).toBeGreaterThan(10)
    expect(oldGrowth).toBeGreaterThan(largeGrowth)
  })

  it('the real reader names spaces this module knows how to talk about', () => {
    const names = readHeapSpaces().map((s) => s.name)
    for (const decisive of DECISIVE_HEAP_SPACES) expect(names).toContain(decisive)
  })
})

interface ReportProbe {
  readonly deps: HeapDiagnosticDeps
  readonly info: string[]
  readonly warn: string[]
  readonly spaceReads: () => number
}

function probe(): ReportProbe {
  let reads = 0
  return {
    info: [],
    warn: [],
    spaceReads: () => reads,
    deps: {
      readMemory: () => mem(),
      readSpaces: () => {
        reads += 1
        return MANY_SMALL
      },
    },
  }
}

function fire(p: ReportProbe): void {
  emitHeapDiagnosticReport(
    {
      label: 'hub/recorder',
      addons: ['pipeline'],
      sink: {
        info: (line) => p.info.push(line),
        warn: (line) => p.warn.push(line),
      },
    },
    p.deps,
  )
}

/**
 * SIGUSR2 reports the numbers and takes NO snapshot (D718).
 *
 * A heap snapshot took the hub down twice; the writer, the cap method and the
 * env flag that once authorised it are all gone, and
 * `scripts/check-no-heap-dump-command.ts` keeps the writer out. What is pinned
 * here is that the cheap half survived — the per-space breakdown is the whole
 * point of the signal — and that the report needs nothing from the
 * environment to be safe.
 */
describe('SIGUSR2 — the free answer, and only the free answer', () => {
  it('reports every non-empty space', () => {
    const p = probe()
    fire(p)
    const report = p.info.join('\n')
    expect(report).toContain('[mem]')
    expect(report).not.toMatch(/snapshot/i)
    expect(p.spaceReads()).toBe(1)
  })
})
