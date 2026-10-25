/**
 * The hour aggregate is a FOLD, and the append path resumes it.
 *
 * ## What this file exists to prevent
 *
 * `recordSegment` used to build its row with `segmentHourRow`, i.e. re-derive
 * the whole hour from its paths on every finalize. That is O(N²) per
 * camera-profile-hour: Σ1..360 ≈ 65 k `parseSegmentPath` calls for a continuous
 * 10 s hour, Σ1..1708 ≈ 1.46 M for the restart-storm hours measured on the hub
 * on 2026-08-29, at ~3.4 finalizes/s fleet-wide, forever.
 *
 * ## Why there are two KINDS of assertion here, and why neither alone is enough
 *
 * The equality tests (`incremental == full`) would pass against the OLD code
 * too — re-deriving the hour trivially equals re-deriving the hour. They pin
 * that the optimisation is *sound*; they cannot detect its absence. So this
 * file also counts `parseSegmentPath` calls: an incremental append parses ONE
 * path however many the hour already holds, and that count is the only
 * assertion that goes red when the fix is reverted. This repo has twice
 * shipped a green suite over a live bug because the test only ever asked the
 * question the fake was happy to answer.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { RecordingIndex } from '../../recording-index.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentRow } from '../../types.js'
import {
  appendSegmentPath,
  EMPTY_HOUR_AGGREGATE,
  hourAggregate,
  SegmentHourLedger,
  segmentHourRow,
  withSegmentPath,
} from '../segment-hour-ledger.js'
import type { SegmentHourRow, SegmentHourRowBase } from '../segment-hour-ledger.js'
import { fakeSettingsStore } from './fixtures/fake-settings-store.js'

/** Bumped by the mocked `parseSegmentPath` below — the cost meter. */
const meter = vi.hoisted(() => ({ parses: 0 }))

type SegmentPathModule = typeof import('../../segment-path.js')

vi.mock('../../segment-path.js', async (importOriginal) => {
  const actual = await importOriginal<SegmentPathModule>()
  return {
    ...actual,
    parseSegmentPath: (relPath: string) => {
      meter.parses += 1
      return actual.parseSegmentPath(relPath)
    },
  }
})

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS
const DEVICE = 102
const PROFILE = 'high'
const LOCATION = 'recordings:default'

/** A continuous 10 s hour holds 360 segments. */
const CONTINUOUS_HOUR = 360
/** One hour row of `592|high` held this many on 2026-08-29 after the restart storm. */
const STORM_HOUR = 1_708

const HOUR_BASE: SegmentHourRowBase = {
  key: `${DEVICE}|${PROFILE}|${LOCATION}|${HOUR0}`,
  deviceId: DEVICE,
  profile: PROFILE,
  locationId: LOCATION,
  hourStartMs: HOUR0,
  paths: [],
}

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  }
  return logger as unknown as IScopedLogger
}

/** The shared fake honours `columns` and `whereIn` — a store that ignored the
 *  projection could not tell a skinny boot from a fat one. */
function fakeStore(): SettingsStoreClient {
  return fakeSettingsStore().store
}

/** Deterministic PRNG — a generated case that cannot be replayed is not a proof. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function segment(startMs: number, bytes: number): SegmentRow {
  return {
    deviceId: DEVICE,
    profile: PROFILE,
    startMs,
    durMs: 10_000,
    bytes,
    path: segmentRelPath(DEVICE, PROFILE, startMs, 10_000, bytes),
    locationId: LOCATION,
  }
}

interface HourShape {
  /** Out-of-order arrival: a restart resumes mid-hour and the watcher replays. */
  readonly shuffle: boolean
  /** Replays of a path already held — what `recordSegment`'s dedup gate exists for. */
  readonly duplicates: number
  /** Non-segment files the parser refuses; they must contribute to neither derivation. */
  readonly garbage: number
}

function generateHour(rnd: () => number, count: number, shape: HourShape): readonly string[] {
  const paths: string[] = []
  for (let i = 0; i < count; i += 1) {
    // A storm hour packs more than 360 starts into the hour; random starts keep
    // the min/max cases honest without leaving the hour.
    const startMs = HOUR0 + Math.floor(rnd() * HOUR_MS)
    paths.push(segmentRelPath(DEVICE, PROFILE, startMs, 10_000, 1 + Math.floor(rnd() * 8_000_000)))
  }
  for (let i = 0; i < shape.duplicates && paths.length > 0; i += 1) {
    paths.push(paths[Math.floor(rnd() * paths.length)]!)
  }
  for (let i = 0; i < shape.garbage; i += 1) {
    paths.push(`${DEVICE}/${PROFILE}/2026/08/29/10/not-a-segment-${i}.tmp`)
  }
  if (shape.shuffle) {
    for (let i = paths.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1))
      const held = paths[i]!
      paths[i] = paths[j]!
      paths[j] = held
    }
  }
  return paths
}

/** The row a FULL derivation builds for these paths. */
function fullRow(paths: readonly string[]): SegmentHourRow {
  return segmentHourRow({ ...HOUR_BASE, paths })
}

/** The row the APPEND path builds, one path at a time. */
function foldRow(paths: readonly string[]): SegmentHourRow {
  let row = fullRow([])
  for (const path of paths) row = appendSegmentPath(row, path)
  return row
}

function aggregateOf(row: SegmentHourRow): Record<string, number> {
  return {
    bytes: row.bytes,
    segments: row.segments,
    minStartMs: row.minStartMs,
    maxStartMs: row.maxStartMs,
  }
}

describe('hourAggregate is the fold of withSegmentPath — one derivation, not two', () => {
  it('the empty aggregate is the fold identity', () => {
    expect(hourAggregate([])).toEqual(EMPTY_HOUR_AGGREGATE)
  })

  it('folding one path at a time equals deriving the whole hour, on generated hours', () => {
    const rnd = mulberry32(0x5eed)
    for (let round = 0; round < 200; round += 1) {
      const paths = generateHour(rnd, Math.floor(rnd() * 40), {
        shuffle: round % 2 === 0,
        duplicates: round % 5,
        garbage: round % 3,
      })
      let folded = EMPTY_HOUR_AGGREGATE
      for (const path of paths) folded = withSegmentPath(folded, path)
      expect(folded).toEqual(hourAggregate(paths))
    }
  })

  /**
   * The equality tests above are RELATIVE: both sides run the same step, so a
   * step that is wrong the same way on both still looks equal. This one is
   * absolute.
   *
   * The case it exists for is the `segments === 0` first-path sentinel. Drop it
   * and `minStartMs` starts from `EMPTY_HOUR_AGGREGATE`'s 0, which no real
   * start is ever below — so every hour in the archive reports
   * `minStartMs: 0`, `accountingForLocations` reports `oldestMs` at the epoch,
   * and retention believes the whole disk is 56 years old. Nothing else in this
   * file notices.
   */
  it('reports the real bytes, count and edges of a known hour', () => {
    const starts = [HOUR0 + 30_000, HOUR0 + 10_000, HOUR0 + 3_104_000, HOUR0 + 20_000]
    const sizes = [11, 22, 33, 44]
    const paths = starts.map((s, i) => segmentRelPath(DEVICE, PROFILE, s, 10_000, sizes[i]!))
    const expected = {
      bytes: 110,
      segments: 4,
      minStartMs: HOUR0 + 10_000,
      maxStartMs: HOUR0 + 3_104_000,
    }
    expect(hourAggregate(paths)).toEqual(expected)
    expect(aggregateOf(foldRow(paths))).toEqual(expected)
  })

  it('a LEADING unparseable path does not consume the first-path sentinel', () => {
    // The `.tmp` contributes nothing, so the first real path must still set
    // both edges rather than being compared against a zero that was never a
    // segment start.
    const junk = `${DEVICE}/${PROFILE}/2026/08/29/10/not-a-segment.tmp`
    const only = segmentRelPath(DEVICE, PROFILE, HOUR0 + 42_000, 10_000, 7)
    expect(hourAggregate([junk, only])).toEqual({
      bytes: 7,
      segments: 1,
      minStartMs: HOUR0 + 42_000,
      maxStartMs: HOUR0 + 42_000,
    })
  })

  it('an hour of ONLY unparseable paths aggregates to nothing, either way', () => {
    const junk = ['', 'nonsense', `${DEVICE}/${PROFILE}/2026/08/29/10/readme.txt`]
    expect(hourAggregate(junk)).toEqual(EMPTY_HOUR_AGGREGATE)
    expect(withSegmentPath(EMPTY_HOUR_AGGREGATE, junk[1]!)).toEqual(EMPTY_HOUR_AGGREGATE)
  })
})

/**
 * The equality is now over the AGGREGATE half alone, because since D523 that is
 * the whole row: `segmentHourRow` folds the listing it is handed and keeps no
 * array, so `toEqual` between a folded row and a fully-derived one compares
 * exactly the four scalars plus the identity. Nothing here got weaker — the
 * array it used to compare was never the thing disk accounting summed.
 */
describe('appendSegmentPath == segmentHourRow over the same paths', () => {
  it('holds on generated hours: out-of-order, duplicated and unparseable paths', () => {
    const rnd = mulberry32(0xc0ffee)
    for (let round = 0; round < 200; round += 1) {
      const paths = generateHour(rnd, Math.floor(rnd() * 60), {
        shuffle: round % 3 !== 0,
        duplicates: round % 7,
        garbage: round % 4,
      })
      expect(foldRow(paths)).toEqual(fullRow(paths))
    }
  })

  it('holds across the 360-segment shape and into storm territory (1 708)', () => {
    const rnd = mulberry32(0x1708)
    for (const count of [1, 2, CONTINUOUS_HOUR - 1, CONTINUOUS_HOUR, STORM_HOUR]) {
      const paths = generateHour(rnd, count, { shuffle: true, duplicates: 3, garbage: 2 })
      expect(foldRow(paths)).toEqual(fullRow(paths))
    }
  })

  it('appending onto an hour rebuilt from the store equals appending onto the held row', async () => {
    // A REAL round trip, because since D523 the stored row IS the aggregate:
    // `rowToValue` writes the four scalars and `recordToRow` takes them back as
    // the database wrote them, with no re-derivation to repair a rounding. If
    // that round trip lost anything, the first append after a restart would
    // resume from a different number than every append before it — and nothing
    // would ever list the hour to notice.
    const store = fakeStore()
    const first = new SegmentHourLedger({ store, logger: silentLogger() })
    await first.declare()
    const rnd = mulberry32(0xb007)
    for (let i = 0; i < 50; i += 1) {
      await first.recordSegment(segment(HOUR0 + Math.floor(rnd() * HOUR_MS), 1 + i * 13))
    }
    const held = first.snapshot()[0]!

    const restarted = new SegmentHourLedger({ store, logger: silentLogger() })
    await restarted.declare()
    await restarted.load()
    const reloaded = restarted.hourRow(DEVICE, PROFILE, LOCATION, HOUR0)!

    expect(reloaded).toEqual(held)
    const fresh = segmentRelPath(DEVICE, PROFILE, HOUR0 + 3_599_000, 10_000, 4242)
    expect(appendSegmentPath(reloaded, fresh)).toEqual(appendSegmentPath(held, fresh))
  })
})

describe('recordSegment appends — it does not re-derive the hour', () => {
  async function openLedger(store: SettingsStoreClient = fakeStore()): Promise<SegmentHourLedger> {
    const ledger = new SegmentHourLedger({ store, logger: silentLogger() })
    await ledger.declare()
    return ledger
  }

  /**
   * The assertion that goes RED when the fix is reverted.
   *
   * An incremental append parses exactly the path that arrived: N appends cost
   * N parses. Re-deriving the hour costs Σ1..N. The ceiling is 2N so an
   * unrelated parse on the path would not make this brittle, and it still
   * leaves three orders of magnitude between pass and fail at storm size
   * (Σ1..1708 = 1 459 486 against a ceiling of 3 416).
   */
  async function parsesToBuildHour(count: number): Promise<number> {
    const ledger = await openLedger()
    const segments: SegmentRow[] = []
    // Every start inside ONE hour: the defect is quadratic in the size of a
    // single hour ROW, so a generator that spilled into the next hour would
    // measure five cheap hours instead of one expensive one.
    const step = Math.floor(HOUR_MS / (count + 1))
    for (let i = 0; i < count; i += 1) {
      segments.push(segment(HOUR0 + i * step, 7_200_000 + i))
    }
    meter.parses = 0
    for (const seg of segments) await ledger.recordSegment(seg)
    expect(ledger.snapshot()).toHaveLength(1)
    return meter.parses
  }

  it('a continuous hour costs one parse per segment, not Σ1..360', async () => {
    expect(await parsesToBuildHour(CONTINUOUS_HOUR)).toBeLessThanOrEqual(CONTINUOUS_HOUR * 2)
  })

  it('a restart-storm hour stays linear — the 1.46 M-parse hour is gone', async () => {
    expect(await parsesToBuildHour(STORM_HOUR)).toBeLessThanOrEqual(STORM_HOUR * 2)
  })

  it('the row it built is the row a full derivation would build', async () => {
    const ledger = await openLedger()
    const rnd = mulberry32(0xfeed)
    const starts: number[] = []
    for (let i = 0; i < 500; i += 1) starts.push(HOUR0 + Math.floor(rnd() * HOUR_MS))
    const paths = starts.map((startMs) => segment(startMs, 1 + (startMs % 9973)).path)
    for (const startMs of starts) await ledger.recordSegment(segment(startMs, 1 + (startMs % 9973)))
    const beforeReplay = aggregateOf(ledger.snapshot()[0]!)
    // Replays inside the same process: the `accounted` set must leave the
    // aggregate untouched. There is no array left to inspect for a duplicate,
    // so the aggregate standing still IS the assertion.
    for (const startMs of starts.slice(0, 25)) {
      await ledger.recordSegment(segment(startMs, 1 + (startMs % 9973)))
    }
    const held = ledger.snapshot()
    expect(held).toHaveLength(1)
    expect(aggregateOf(held[0]!)).toEqual(beforeReplay)
    // And what the appends built is what one full derivation over the DISTINCT
    // names would have built — the generator repeats a start now and then, and
    // a name that arrives twice is one file on the array.
    expect(beforeReplay).toEqual(hourAggregate([...new Set(paths)]))
  })

  it('the hour survives a restart with the same aggregate', async () => {
    const store = fakeStore()
    const first = await openLedger(store)
    for (let i = 0; i < 120; i += 1) await first.recordSegment(segment(HOUR0 + i * 10_000, 500 + i))
    const before = first.snapshot()[0]!

    const restarted = await openLedger(store)
    const loaded = await restarted.load()
    expect(loaded).toHaveLength(1)
    // Since D523 the row IS the aggregate, so the restart loads the whole of
    // it: no summary tier to widen later, no detail read to pay. The aggregate
    // is what disk accounting is a SUM over, so it is what must survive the
    // restart unchanged — and now "unchanged" means the entire row.
    expect(loaded[0]).toEqual(before)
  })
})

describe('reconcileFromIndex accumulates hours incrementally too', () => {
  it('a walked hour costs a parse per segment, and lands the same row', async () => {
    const ledger = new SegmentHourLedger({ store: fakeStore(), logger: silentLogger() })
    await ledger.declare()
    const index = new RecordingIndex()
    const paths: string[] = []
    for (let i = 0; i < CONTINUOUS_HOUR; i += 1) {
      const seg = segment(HOUR0 + i * 10_000, 6_000_000 + i)
      index.addSegment(seg)
      paths.push(seg.path)
    }

    meter.parses = 0
    await ledger.reconcileFromIndex(index, [DEVICE], HOUR0 + HOUR_MS + 60_000)
    const parses = meter.parses

    const row = ledger.snapshot()[0]!
    expect(row.segments).toBe(CONTINUOUS_HOUR)
    expect(aggregateOf(row)).toEqual(hourAggregate(paths))
    // Σ1..360 = 64 980 before. The reconcile parses nothing else per segment,
    // so 2N is again the honest ceiling.
    expect(parses).toBeLessThanOrEqual(CONTINUOUS_HOUR * 2)
  })
})
