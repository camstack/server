/**
 * gc-census — HOW OFTEN V8 collects, on the ordinary heartbeat.
 *
 * ## The question this exists to answer, and why four records could not
 *
 * A garbage collector's cost is a product of two independent things: the LIVE
 * SET (how much there is to mark) and the RATE at which a cycle is triggered.
 * The `[mem]` line has carried the live set since 2026-08-29 — `heapUsed`,
 * `oldSpace`, `largeObjectSpace`, `external`, `arrayBuffers` — and has never
 * carried the rate. So D443, D444, D446 and D456 each read a level, saw it flat
 * or falling, and could not say whether the GC share they were looking at came
 * from the size of the heap or from the frequency of the collection. D444 cut
 * hub-main's live set from 2 491 MB to 714 MB — a factor of 3.5 — and the GC
 * share did not move. That result was unreadable until the rate was measured.
 *
 * Measured on hub-main 2026-09-11 with the observer below, the answer was on
 * sight: **1.39 major mark-compacts per second against a 602 MB live set whose
 * old space grew 22 MB/s.** A major GC every 0.7 s cannot be explained by 22
 * MB/s of heap growth under a 3 264 MB ceiling — V8 was being driven by
 * EXTERNAL memory pressure (537 MB/s of ArrayBuffer allocation, D458), and each
 * of those cycles then had to mark the 602 MB live set on four platform
 * workers. That is 70 % of the process.
 *
 * ## Why counts and not a rate of bytes
 *
 * An allocation rate sampled from `process.memoryUsage()` on this heartbeat
 * would be a lie with a number on it. The probe runs every 2 s; external memory
 * on hub-main cycles many times inside 2 s, so a sum of positive deltas
 * under-reports it by more than an order of magnitude (a 100 ms sampler already
 * reported 234 MB/s where a 5 ms one would have said 537). The GC COUNT is
 * exact at any cadence — V8 reports every cycle — and it is the half of the
 * product the line was missing. Read against the `oldSpace=` field already on
 * the line, the two together say which economy is paying:
 *
 *  - many majors, little old-space growth between them ⇒ EXTERNAL pressure.
 *    The fix is an allocation site, and shrinking the live set buys nothing.
 *  - majors that track old-space growth ⇒ the heap is genuinely filling.
 *    The fix is retention.
 *
 * ## Cost
 *
 * One prologue/epilogue callback per GC, into a counter. On hub-main at its
 * worst that is ~4 entries/s. The observer was run against the live hub three
 * times for 90 s while this was written, with no measurable effect on the
 * process; `Profiler.start`, by comparison, stalls it 867 ms (D456).
 *
 * Absence is never zero (D393): a runtime that will not give an observer
 * reports NOTHING on the line, not a census of zero collections.
 */

/** One window of collections, as V8 counted them. */
export interface GcCensusWindow {
  /** Full mark-compacts. The expensive kind: every one marks the live set. */
  readonly majors: number
  /** Scavenges of the young generation. */
  readonly minors: number
  /** Incremental marking steps on the main thread. */
  readonly incrementals: number
  /** Total MAIN-THREAD pause across the window. Never the concurrent work. */
  readonly pauseMs: number
  /** How long the window was, so a rate can be computed from the line. */
  readonly windowMs: number
  /**
   * Cycles in the window by V8 trigger flag NAME (`ALL_EXTERNAL_MEMORY`,
   * `FORCED`, ...). A cycle can carry several flags and counts under each. This
   * is what separates "driven by external-memory pressure" from "the heap is
   * filling" ON THE LINE, instead of by inference from the rate (D867).
   * Absent = the runtime reported no flag names.
   */
  readonly flags?: Readonly<Record<string, number>>
}

/**
 * A census that accumulates until it is read, then starts a new window.
 *
 * Window semantics, not cumulative, for the reason D456 gives: a line printing
 * a lifetime total says nothing about the minute it describes, and the reader
 * has to diff two lines by hand to learn anything.
 */
export interface GcCensus {
  /** The window since the previous read. `null` until the first full window. */
  readonly read: (at: number) => GcCensusWindow | null
  readonly stop: () => void
}

/** What the census counts. Node's `PerformanceEntry.detail.kind` values. */
export interface GcObservation {
  readonly kind: number
  readonly durationMs: number
  /** `detail.flags` bitmask; absent when the entry carried none. */
  readonly flags?: number
}

/** One V8 GC flag: its Node constant name (without the prefix) and its bit. */
export interface GcFlagBit {
  readonly name: string
  readonly bit: number
}

/**
 * How the census is fed. Injectable so a spec can pose a sequence of
 * collections without provoking real ones, which is not something a test can
 * do deterministically.
 */
export type GcObserverInstall = (
  observe: (entry: GcObservation) => void,
) => (() => void) | undefined

/**
 * V8's kinds, as Node reports them on `detail.kind`.
 *
 * Read from `perf_hooks.constants` rather than written as literals: the values
 * are a Node ABI, and a literal `4` in this file would keep compiling and stop
 * meaning "major" the release it changed.
 */
export interface GcKinds {
  readonly major: number
  readonly minor: number
  readonly incremental: number
}

function countsOf(
  entries: readonly GcObservation[],
  kinds: GcKinds,
  flagBits: readonly GcFlagBit[],
): GcCensusWindow {
  const flags: Record<string, number> = {}
  let majors = 0
  let minors = 0
  let incrementals = 0
  let pauseMs = 0
  for (const e of entries) {
    if (e.kind === kinds.major) majors++
    else if (e.kind === kinds.minor) minors++
    else if (e.kind === kinds.incremental) incrementals++
    pauseMs += e.durationMs
    if (e.flags !== undefined) {
      for (const f of flagBits) {
        if ((e.flags & f.bit) !== 0) flags[f.name] = (flags[f.name] ?? 0) + 1
      }
    }
  }
  return {
    majors,
    minors,
    incrementals,
    pauseMs,
    windowMs: 0,
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
  }
}

/**
 * The shortest window a rate may be quoted over.
 *
 * One second, and the number comes from the line this field lives on: the boot
 * line is printed microseconds after the watch starts, and `maj0@0s` there
 * would be a rate computed over no time at all — indistinguishable on sight
 * from a process that is genuinely not collecting. Below the floor the census
 * says NOTHING, which is the same discipline as an unobservable runtime
 * (D393): a window too short to answer is not an answer of zero.
 */
export const GC_CENSUS_MIN_WINDOW_MS = 1_000

/**
 * Build a census over an injected observer.
 *
 * Returns `undefined` when the observer cannot be installed — the caller then
 * prints nothing, which is the honest reading. It must never degrade into a
 * census that reports zero collections: a process whose GC is not being
 * observed and a process that is not collecting look identical on the line, and
 * they are the two answers furthest apart.
 */
export function createGcCensus(
  install: GcObserverInstall,
  kinds: GcKinds,
  startedAt: number,
  flagBits: readonly GcFlagBit[] = [],
): GcCensus | undefined {
  let pending: GcObservation[] = []
  const stopObserving = install((entry) => {
    pending.push(entry)
  })
  if (stopObserving === undefined) return undefined
  let windowStart = startedAt
  return {
    read: (at: number): GcCensusWindow | null => {
      const windowMs = at - windowStart
      if (windowMs < GC_CENSUS_MIN_WINDOW_MS) return null
      const taken = pending
      pending = []
      windowStart = at
      const counts = countsOf(taken, kinds, flagBits)
      return { ...counts, windowMs }
    },
    stop: (): void => {
      stopObserving()
      pending = []
    },
  }
}

/** The real Node observer and the real kind constants, wrapped so they can be replaced in a spec. */
export interface NodeGcObserver {
  readonly install: GcObserverInstall
  readonly kinds: GcKinds
  /** Names of the flag bits `detail.flags` can carry. Empty = unreadable. */
  readonly flagBits?: readonly GcFlagBit[]
}

/**
 * The observer this process actually gets.
 *
 * Everything that can fail is inside the try: a runtime without
 * `perf_hooks`, without the `gc` entry type, or without the kind constants
 * yields `undefined` from `install`, and {@link createGcCensus} then declines
 * to exist rather than reporting zeros.
 */
export function nodeGcObserver(): NodeGcObserver {
  const kinds: GcKinds = { major: 4, minor: 1, incremental: 8 }
  return {
    kinds: readKinds(kinds),
    flagBits: readFlagBits(),
    install: (observe): (() => void) | undefined => {
      try {
        // Required lazily: this module is imported by every runner, and a
        // process that never starts a heap watch must not pay for it.
        const perf: typeof import('node:perf_hooks') = process.getBuiltinModule('node:perf_hooks')
        const observer = new perf.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // `PerformanceEntry` does not declare `detail`; the `gc` entries
            // carry it. Narrowed with `in` rather than asserted with a cast.
            const detail: unknown = 'detail' in entry ? entry.detail : undefined
            const kind =
              typeof detail === 'object' &&
              detail !== null &&
              'kind' in detail &&
              typeof detail.kind === 'number'
                ? detail.kind
                : -1
            const flags =
              typeof detail === 'object' &&
              detail !== null &&
              'flags' in detail &&
              typeof detail.flags === 'number'
                ? detail.flags
                : undefined
            observe({ kind, durationMs: entry.duration, ...(flags !== undefined ? { flags } : {}) })
          }
        })
        observer.observe({ entryTypes: ['gc'] })
        return (): void => {
          observer.disconnect()
        }
      } catch {
        return undefined
      }
    },
  }
}

const GC_FLAG_PREFIX = 'NODE_PERFORMANCE_GC_FLAGS_'

/**
 * The flag bits, read from `perf_hooks.constants` by their prefix so a flag V8
 * adds tomorrow gets a name without anyone editing a table. `NO` (0) can never
 * match a bit and is dropped.
 */
function readFlagBits(): readonly GcFlagBit[] {
  try {
    const perf: typeof import('node:perf_hooks') = process.getBuiltinModule('node:perf_hooks')
    const bits: GcFlagBit[] = []
    for (const [key, value] of Object.entries(perf.constants)) {
      if (key.startsWith(GC_FLAG_PREFIX) && typeof value === 'number' && value > 0) {
        bits.push({ name: key.slice(GC_FLAG_PREFIX.length), bit: value })
      }
    }
    return bits
  } catch {
    return []
  }
}

function readKinds(fallback: GcKinds): GcKinds {
  try {
    const perf: typeof import('node:perf_hooks') = process.getBuiltinModule('node:perf_hooks')
    const c = perf.constants
    return {
      major: c.NODE_PERFORMANCE_GC_MAJOR,
      minor: c.NODE_PERFORMANCE_GC_MINOR,
      incremental: c.NODE_PERFORMANCE_GC_INCREMENTAL,
    }
  } catch {
    return fallback
  }
}

/**
 * The two fields, APPENDED LAST on the `[mem]` line.
 *
 * D446's rule: no existing field moves, so every Loki prefix written since
 * 2026-08-29 still matches. `gc=` prints even when nothing was collected — a
 * window with no collections is a reading, and it is the reading that says a
 * process is idle rather than unobserved. `gcPauseMs=` is the MAIN-THREAD
 * pause only; the concurrent marking that cost hub-main 70 % of its CPU is on
 * the platform workers and no in-process counter sees it, which is why the
 * field is named for the thread it describes (D456, part 4).
 */
export function formatGcCensus(window: GcCensusWindow | null | undefined): string {
  if (window === null || window === undefined) return ''
  const perMin = (n: number): string =>
    window.windowMs <= 0 ? '?' : (n / (window.windowMs / 60000)).toFixed(1)
  return (
    ` gc=maj${window.majors}/min${window.minors}/inc${window.incrementals}` +
    `@${Math.round(window.windowMs / 1000)}s gcMajPerMin=${perMin(window.majors)} ` +
    `gcPauseMs=${Math.round(window.pauseMs)}` +
    formatGcFlags(window.flags)
  )
}

/** ` gcFlags=ALL_EXTERNAL_MEMORY:12,FORCED:1` — most frequent first; empty when none. */
function formatGcFlags(flags: Readonly<Record<string, number>> | undefined): string {
  if (flags === undefined) return ''
  const entries = Object.entries(flags).toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (entries.length === 0) return ''
  return ` gcFlags=${entries.map(([name, n]) => `${name}:${n}`).join(',')}`
}
