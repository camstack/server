/**
 * What the recorder's boot load reads, and what the boot no longer costs.
 *
 * Boot used to fetch the WHOLE hour collection in one query — ~16 MB of JSON on
 * the live hub, a projected ~460 MB at 28 TB, parsed on the main thread before
 * the index exists — and then replay every hour into `RecordingIndex` in one
 * synchronous fold. An addon deploy restarts this runner, so both were a
 * recurring tax that grew with the disk.
 *
 * D287 answered the SIZE of that response by splitting the table in two: a
 * summary tier boot read, and a fat `paths` column materialised on demand.
 * D523 deleted the fat column instead, and with it the tier — the table now
 * answers HOW MUCH an hour holds and the DIRECTORY answers WHICH files it
 * holds. A row is ten scalars, so the whole ledger loads in one query with no
 * projection to choose and no second read to pace.
 *
 * What this file pins, each failing for a different reason:
 *
 *  1. **the statement, not the outcome** — the boot query carries no `columns`
 *     projection, because there is no fat column left to omit, and no response
 *     at boot carries a path. A boot that fetched paths and dropped them in JS
 *     would pass every outcome assertion and still be the OOM;
 *  2. **the loop is not blocked** — the fold yields, with a measured bound on
 *     the longest synchronous run;
 *  3. **a load that dropped work SAYS SO** — malformed rows and the row cap;
 *  4. **boot seeds NOTHING into `RecordingIndex`** — unconditionally now: a
 *     ledger-known hour is not "hydratable from a second tier", it is simply
 *     not in the index, and only a directory listing can put it there;
 *  5. **the write path reads NOTHING** — a finalize creates or appends from the
 *     mirror alone. That is what replaced D287's "materialise the live tail at
 *     boot so the write path can gate from RAM": there is nothing left to
 *     materialise, so there is nothing left to race.
 */
import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { RecordingIndex } from '../../recording-index.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentRow } from '../../types.js'
import { RECORDING_SEGMENT_HOURS_COLLECTION, SegmentHourLedger } from '../segment-hour-ledger.js'
import type { LedgerLoadPacing } from '../segment-hour-ledger.js'
import { fakeSettingsStore, type FakeSettingsStore } from './fixtures/fake-settings-store.js'

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS
const DEVICE = 102

interface Recorded {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: unknown
}

function recordingLogger(lines: Recorded[]): IScopedLogger {
  const push =
    (level: Recorded['level']) =>
    (message: string, extras?: unknown): void => {
      lines.push({ level, message, extras })
    }
  const logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  } as unknown as IScopedLogger
  return logger
}

function segment(startMs: number, bytes = 7_000_000, profile = 'high'): SegmentRow {
  return {
    deviceId: DEVICE,
    profile,
    startMs,
    durMs: 10_000,
    bytes,
    path: segmentRelPath(DEVICE, profile, startMs, 10_000, bytes),
    locationId: 'recordings:default',
  }
}

interface WrittenArchive {
  readonly fake: FakeSettingsStore
  readonly hours: number
  readonly segments: number
}

/**
 * Fill a store the way the recorder fills it: through `recordSegment`, one
 * finalize at a time. A synthetic archive built by hand-writing rows would not
 * exercise the append path the restart has to resume.
 */
async function writeArchive(hours: number, perHour: number): Promise<WrittenArchive> {
  const fake = fakeSettingsStore()
  const writer = new SegmentHourLedger({ store: fake.store, logger: recordingLogger([]) })
  await writer.declare()
  for (let h = 0; h < hours; h += 1) {
    for (let s = 0; s < perHour; s += 1) {
      await writer.recordSegment(segment(HOUR0 - h * HOUR_MS + s * 10_000, 7_000_000 + s))
    }
  }
  return { fake, hours, segments: hours * perHour }
}

/** A ledger whose clock is far past the written archive — every hour it loads
 *  is closed. */
function reopen(
  fake: FakeSettingsStore,
  lines: Recorded[],
  pacing?: LedgerLoadPacing,
): SegmentHourLedger {
  return new SegmentHourLedger({
    store: fake.store,
    logger: recordingLogger(lines),
    now: () => HOUR0 + 100 * HOUR_MS,
    ...(pacing ? { loadPacing: pacing } : {}),
  })
}

describe('boot loads the ledger entire, and it is small because the row is (D523)', () => {
  it('asks ONE query, with no columns projection — there is no fat column left to omit', async () => {
    const { fake } = await writeArchive(6, 12)
    const lines: Recorded[] = []
    const ledger = reopen(fake, lines)
    fake.queries.length = 0

    await ledger.load()

    // The statement, not the outcome. Under D287 the projection was the whole
    // defence, and asserting it was how a boot that fetched `paths` and threw
    // them away got caught. The defence now is that the COLUMN does not exist,
    // so a projection would be a list of every column there is — noise that
    // has to be kept in step with the schema for nothing.
    expect(fake.queries).toHaveLength(1)
    const boot = fake.queries[0]
    expect(boot?.collection).toBe(RECORDING_SEGMENT_HOURS_COLLECTION)
    expect(boot?.columns).toBeUndefined()
  })

  it('no RESPONSE at boot carries a path — the table names no file', async () => {
    const { fake } = await writeArchive(6, 12)
    const ledger = reopen(fake, [])
    // Watch what comes BACK, not what is parsed: with no projection to hide
    // behind, the response is the schema, and a `paths` key in it would mean
    // the column came back from the dead.
    const received: string[] = []
    const inner = fake.store.query.query
    Object.defineProperty(fake.store.query, 'query', {
      value: async (input: Parameters<typeof inner>[0]) => {
        const out = await inner(input)
        for (const record of out) received.push(...Object.keys(record.data))
        return out
      },
    })

    const rows = await ledger.load()

    expect(received.length).toBeGreaterThan(0)
    expect(received).not.toContain('paths')
    // And each row reports its real aggregate — that is the whole of what a row
    // is now, so nothing is deferred and nothing is owed.
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.segments).toBe(12)
      expect(row.bytes).toBeGreaterThan(0)
      expect(row.minStartMs).toBeGreaterThan(0)
      expect(row.maxStartMs).toBeGreaterThanOrEqual(row.minStartMs)
    }
  })

  it('SAYS SO when the row cap truncated the archive', async () => {
    // The cap is a bound, and a bound that is reached has dropped work. Hours
    // past it are unknown to this process and get walked from disk — which is
    // survivable, and silence about it is not.
    const { fake } = await writeArchive(9, 2)
    const lines: Recorded[] = []
    const ledger = new SegmentHourLedger({
      store: fake.store,
      logger: recordingLogger(lines),
      now: () => HOUR0 + 1_000 * HOUR_MS,
      loadPacing: { rowCap: 4 },
    })
    fake.queries.length = 0

    const rows = await ledger.load()

    expect(rows).toHaveLength(4)
    expect(fake.queries[0]?.filter?.limit).toBe(4)
    const capped = lines.find((l) => /hit its row cap/.test(l.message))
    expect(capped?.level).toBe('warn')
    expect((capped?.extras as { meta?: { limit?: number } })?.meta?.limit).toBe(4)
  })

  it('says nothing about the cap when the archive fits under it', async () => {
    const { fake } = await writeArchive(3, 2)
    const lines: Recorded[] = []
    await reopen(fake, lines, { rowCap: 100 }).load()
    expect(lines.some((l) => /hit its row cap/.test(l.message))).toBe(false)
  })

  it('SKIPS a malformed row rather than repairing it, and says how many', async () => {
    const { fake } = await writeArchive(3, 5)
    // A row that cannot say which camera, profile, location and hour it is
    // about is DISCARDED: a row keyed on garbage would gate the write path for
    // an hour that is perfectly fine. Repairing it would be inventing an
    // archive nobody measured.
    await fake.store.set.mutate({
      collection: RECORDING_SEGMENT_HOURS_COLLECTION,
      key: 'junk',
      value: { deviceId: 'nope', segments: 12, bytes: 99 },
    })
    const lines: Recorded[] = []
    const ledger = reopen(fake, lines)

    const rows = await ledger.load()

    expect(rows).toHaveLength(3)
    const skipped = lines.find((l) => /skipped as malformed/.test(l.message))
    expect(skipped?.level).toBe('warn')
    expect((skipped?.extras as { meta?: { skipped?: number } })?.meta?.skipped).toBe(1)
  })

  it('the boot log reports what it loaded and what it dropped', async () => {
    const { fake } = await writeArchive(3, 5)
    const lines: Recorded[] = []
    await reopen(fake, lines).load()
    const loaded = lines.find((l) => l.message.includes('segment-hour ledger loaded'))
    const meta = (loaded?.extras as { meta?: { hours?: number; skipped?: number } })?.meta
    expect(meta?.hours).toBe(3)
    expect(meta?.skipped).toBe(0)
  })
})

describe('boot does not block the loop', () => {
  /**
   * The longest run of rows folded WITHOUT giving the loop back.
   *
   * Measured, not asserted from the chunk constant: the mirror's size at each
   * yield is the exact number of rows folded so far, so the largest gap
   * between consecutive observations (plus the tail after the last yield) is
   * the longest synchronous stretch. A fold with no yield scores the whole
   * archive — which is precisely what the deleted `hydrateIndex` replay did.
   */
  async function longestRunOf(hours: number, chunkSize: number): Promise<number> {
    const { fake } = await writeArchive(hours, 1)
    const marks: number[] = [0]
    const ledger = new SegmentHourLedger({
      store: fake.store,
      logger: recordingLogger([]),
      now: () => HOUR0 + 10_000 * HOUR_MS,
      loadPacing: {
        chunkSize,
        yieldBetween: async () => {
          marks.push(ledger.snapshot().length)
          await new Promise<void>((resolve) => {
            setImmediate(resolve)
          })
        },
      },
    })
    await ledger.load()
    marks.push(hours)
    let longest = 0
    for (let i = 1; i < marks.length; i += 1) {
      longest = Math.max(longest, marks[i]! - marks[i - 1]!)
    }
    return longest
  }

  it('folds a large ledger in bounded chunks with a yield between them', async () => {
    const { fake } = await writeArchive(400, 1)
    let yields = 0
    const ledger = new SegmentHourLedger({
      store: fake.store,
      logger: recordingLogger([]),
      now: () => HOUR0 + 1000 * HOUR_MS,
      loadPacing: {
        chunkSize: 50,
        yieldBetween: async () => {
          yields += 1
          await new Promise<void>((resolve) => {
            setImmediate(resolve)
          })
        },
      },
    })

    await ledger.load()

    // 400 rows in chunks of 50 is 8 chunks, so 7 yields between them. A fold
    // with no yield at all scores 0, which is exactly what the deleted
    // `hydrateIndex` replay did over the WHOLE archive.
    expect(yields).toBe(7)
    expect(ledger.snapshot()).toHaveLength(400)
  })

  it('yields often enough that the synchronous run is the chunk, not the archive', async () => {
    expect(await longestRunOf(300, 25)).toBeLessThanOrEqual(25)
  })

  it('a small ledger needs no yield at all', async () => {
    const { fake } = await writeArchive(3, 4)
    let yields = 0
    const ledger = new SegmentHourLedger({
      store: fake.store,
      logger: recordingLogger([]),
      now: () => HOUR0 + 1000 * HOUR_MS,
      loadPacing: { chunkSize: 5_000, yieldBetween: async () => void (yields += 1) },
    })
    await ledger.load()
    expect(yields).toBe(0)
  })
})

describe('boot seeds NOTHING into the RecordingIndex (D523)', () => {
  it('boot replays NOTHING into the index — the hours stay unknown', async () => {
    const { fake } = await writeArchive(5, 10)
    const ledger = reopen(fake, [])
    await ledger.load()

    const index = new RecordingIndex()
    // Unconditional now. Under D287 a ledger-known hour was "hydratable" — the
    // paths were in the table, one point read away — so `unknown` was a
    // deferral. Since D523 the ledger holds no path at all: `unknown` is the
    // whole truth about the hour, and every read path already treats it as
    // "walk it".
    expect(index.hydrationOf(DEVICE, HOUR0, HOUR0 + HOUR_MS)).toBe('unknown')
    expect(index.segments(DEVICE)).toEqual([])
  })

  it('the LISTING is what seeds the index — nothing else can', async () => {
    const { fake } = await writeArchive(1, 30)
    const ledger = reopen(fake, [])
    await ledger.load()

    const held = ledger.hourRow(DEVICE, 'high', 'recordings:default', HOUR0)
    expect(held?.segments).toBe(30)

    // The row says HOW MUCH and names no file, so the only way into the index
    // is a directory read — the same names the writer laid down.
    const paths: string[] = []
    for (let s = 0; s < 30; s += 1) {
      paths.push(segment(HOUR0 + s * 10_000, 7_000_000 + s).path)
    }
    const index = new RecordingIndex()
    index.hydrateHour(DEVICE, 'recordings:default', HOUR0, paths)

    expect(index.hydrationOf(DEVICE, HOUR0, HOUR0 + HOUR_MS)).toBe('hydrated')
    expect(index.accounting(DEVICE).count).toBe(30)
    // And the listing agrees with the row it was never derived from — the two
    // authorities describing the same hour.
    expect(index.accounting(DEVICE).bytes).toBe(held?.bytes)
  })
})

describe('the write path issues no store READ at all (D523)', () => {
  it('a finalize into an hour the mirror does not hold CREATES the row, with no query', async () => {
    const { fake } = await writeArchive(1, 5)
    const ledger = new SegmentHourLedger({
      store: fake.store,
      logger: recordingLogger([]),
      now: () => HOUR0 + HOUR_MS,
    })
    await ledger.load()
    fake.queries.length = 0

    await ledger.recordSegment(segment(HOUR0 + HOUR_MS + 1_000))

    expect(fake.queries).toEqual([])
    expect(ledger.hourRow(DEVICE, 'high', 'recordings:default', HOUR0 + HOUR_MS)).toMatchObject({
      segments: 1,
    })
  })

  it('a finalize into an hour the mirror DOES hold appends, with no query', async () => {
    const { fake } = await writeArchive(1, 40)
    const lines: Recorded[] = []
    // The clock is INSIDE the hour the previous process was writing — the case
    // D287 had to materialise a live tail for, so that the write path could
    // gate from RAM instead of racing a point read.
    const ledger = new SegmentHourLedger({
      store: fake.store,
      logger: recordingLogger(lines),
      now: () => HOUR0 + 40 * 10_000,
    })
    await ledger.load()
    fake.queries.length = 0

    await ledger.recordSegment(segment(HOUR0 + 40 * 10_000))

    // 41, not 1, and no read to get there. A boot that resumed from a summary
    // it could not append to would have rewritten the hour as the single path
    // that happened to arrive first.
    expect(fake.queries).toEqual([])
    const after = ledger.hourRow(DEVICE, 'high', 'recordings:default', HOUR0)
    expect(after?.segments).toBe(41)
  })

  it('a store whose READS are down cannot make the write path lose the hour', async () => {
    const { fake } = await writeArchive(1, 40)
    const lines: Recorded[] = []
    const ledger = new SegmentHourLedger({
      store: fake.store,
      logger: recordingLogger(lines),
      now: () => HOUR0 + 40 * 10_000,
    })
    await ledger.load()
    fake.failQueries = true

    await ledger.recordSegment(segment(HOUR0 + 40 * 10_000))

    // The 40 the previous process accounted for are in the mirror, the append
    // resumes from them, and the durable row is rewritten as 41 — a read
    // outage has nothing to break here because nothing is read.
    expect(ledger.hourRow(DEVICE, 'high', 'recordings:default', HOUR0)?.segments).toBe(41)
    const stored = fake.rows(RECORDING_SEGMENT_HOURS_COLLECTION)[0]
    expect(stored?.data['segments']).toBe(41)
  })
})

describe('a failing read changes nothing (D49)', () => {
  it('a failed BOOT load keeps the hours already held', async () => {
    const { fake } = await writeArchive(4, 6)
    const lines: Recorded[] = []
    const ledger = reopen(fake, lines)
    await ledger.load()
    expect(ledger.snapshot()).toHaveLength(4)

    fake.failQueries = true
    const again = await ledger.load()

    expect(again).toHaveLength(4)
    expect(
      lines.some((l) => /ledger load failed — keeping the hours already held/.test(l.message)),
    ).toBe(true)
  })

  it('eviction shrinks the hour from the mirror — a dead store changes neither direction', async () => {
    const { fake } = await writeArchive(1, 12)
    const lines: Recorded[] = []
    const ledger = reopen(fake, lines)
    await ledger.load()
    fake.failQueries = true
    fake.deletes.length = 0

    await ledger.dropSegments([segment(HOUR0)])

    // `dropSegments` used to read the hour's paths to decide whether anything
    // was left, so a failed read had to be turned into a refusal. It subtracts
    // from the mirror now: 11 of 12 survive and the row is not forgotten.
    expect(fake.deletes).toEqual([])
    expect(ledger.hourRow(DEVICE, 'high', 'recordings:default', HOUR0)?.segments).toBe(11)
  })

  it('a reconcile asks the store NOTHING, so a read outage cannot make it prune', async () => {
    const { fake } = await writeArchive(20, 10)
    const lines: Recorded[] = []
    const ledger = reopen(fake, lines)
    await ledger.load()
    fake.failQueries = true
    fake.deletes.length = 0
    fake.queries.length = 0

    // An empty index is exactly the 2026-08-19 unmounted-root shape, and the
    // magnitude guard is what refuses it — from the mirror, with no I/O to go
    // wrong on the way to the verdict.
    await ledger.reconcileFromIndex(new RecordingIndex(), [DEVICE], HOUR0 + 200 * HOUR_MS)

    expect(fake.queries).toEqual([])
    expect(fake.deletes).toEqual([])
    expect(fake.rows(RECORDING_SEGMENT_HOURS_COLLECTION)).toHaveLength(20)
    expect(lines.some((l) => l.level === 'warn' && /prune REFUSED/.test(l.message))).toBe(true)
  })
})
