/**
 * The DURABLE half of a relocation.
 *
 * `RelocateEngine` used to re-point `RecordingIndex` and nothing else, and that
 * index is RAM: a drain that moved bytes without moving the durable hour row
 * left the hour ACCOUNTED at the drained location for the life of the hub —
 * counted on every storage page, walked again by the next drain, and once the
 * drained location is deleted charged to a root that no longer exists. That is
 * the shape of the 2 131 `recordings:high` ghost rows the live hub carried.
 *
 * Since D523 the table no longer names files: it says how MUCH each
 * `(device, profile, location, hour)` holds, and the DIRECTORY says which files
 * those are. So the durable half of a relocation is an arithmetic move of one
 * hour's account from the source location's row to the target's — and every
 * assertion here is about the same invariant: **at no instant is a segment
 * accounted NOWHERE, and the location an account names always holds the
 * bytes.**
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  hourDirRelPath,
  type RecordingsLocation,
  recordingsLocationOfMode,
} from '../addon/roots.js'
import { type HourLister, SegmentHourLedger } from '../addon/segment-hour-ledger.js'
import { RecordingIndex } from '../recording-index.js'
import { RelocateEngine, type RelocateHourLedger } from '../relocate-engine.js'
import { segmentRelPath } from '../segment-path.js'
import type { RelocatedSegment, SegmentRow } from '../types.js'

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS
const DEVICE = 102

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

/** The same in-memory settings store the hour-ledger suite uses. */
function fakeStore(): SettingsStoreClient {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const ensure = (collection: string): Map<string, Record<string, unknown>> => {
    let m = tables.get(collection)
    if (!m) {
      m = new Map()
      tables.set(collection, m)
    }
    return m
  }
  return {
    declareCollection: {
      mutate: async (input: { collection: string }): Promise<void> => {
        ensure(input.collection)
      },
    },
    set: {
      mutate: async (input: { collection: string; key: string; value: unknown }): Promise<void> => {
        ensure(input.collection).set(input.key, input.value as Record<string, unknown>)
      },
    },
    delete: {
      mutate: async (input: { collection: string; key: string }): Promise<void> => {
        tables.get(input.collection)?.delete(input.key)
      },
    },
    query: {
      query: async (input: {
        collection: string
      }): Promise<readonly { id: string; data: Record<string, unknown> }[]> =>
        [...(tables.get(input.collection)?.entries() ?? [])].map(([id, data]) => ({ id, data })),
    },
  } as unknown as SettingsStoreClient
}

interface Roots {
  readonly from: RecordingsLocation
  readonly to: RecordingsLocation
}

function makeRoots(): Roots {
  return {
    from: recordingsLocationOfMode(
      {
        id: 'recordings:spindle',
        type: 'recordings',
        root: mkdtempSync(path.join(tmpdir(), 'drain-from-')),
      },
      'active',
    ),
    to: recordingsLocationOfMode(
      {
        id: 'recordings:ssd',
        type: 'recordings',
        root: mkdtempSync(path.join(tmpdir(), 'drain-to-')),
      },
      'active',
    ),
  }
}

/**
 * The ledger's only connection to the array (D523): a real directory read of
 * one hour bucket, location-relative, `[]` when the directory is not there.
 *
 * Wiring it is not fixture decoration. `streamSegments` probes the table for
 * the HOURS and then LISTS each of those directories for the names, so a
 * ledger with no lister has nothing to hand the mover and every drain below
 * would pass on an empty work list.
 */
function listerOver(roots: Roots): HourLister {
  const rootsById = new Map<string, string>([
    [roots.from.id, roots.from.root],
    [roots.to.id, roots.to.root],
  ])
  return async (locationId, deviceId, profile, hour) => {
    const root = rootsById.get(locationId)
    if (root === undefined) return null
    const rel = hourDirRelPath(deviceId, profile, hour)
    try {
      return readdirSync(path.join(root, rel))
        .filter((name) => name.endsWith('.m4s'))
        .map((name) => `${rel}/${name}`)
    } catch {
      return []
    }
  }
}

/** Write `count` 10 s segments of one hour to `root`, and return their rows. */
function seedHour(root: string, locationId: string, hour: number, count: number): SegmentRow[] {
  const rows: SegmentRow[] = []
  for (let i = 0; i < count; i++) {
    const startMs = hour + i * 10_000
    const bytes = 100 + i
    const rel = segmentRelPath(DEVICE, 'high', startMs, 10_000, bytes)
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, Buffer.alloc(bytes, 7))
    rows.push({
      deviceId: DEVICE,
      profile: 'high',
      startMs,
      durMs: 10_000,
      bytes,
      path: rel,
      locationId,
    })
  }
  return rows
}

async function runDrain(
  roots: Roots,
  index: RecordingIndex,
  ledger: RelocateHourLedger | null,
  onFirstCopy?: (engine: RelocateEngine, jobId: string) => void,
): Promise<string> {
  const engine = new RelocateEngine({
    index,
    locations: () => [roots.from, roots.to],
    ledger: () => ledger,
    logger: silentLogger(),
    now: () => Date.now(),
    newId: () => 'job-1',
    sleep: async () => {},
    // A roomy destination, stated rather than measured: the drain refuses a
    // destination below its `minFreePercent` floor, and these fixtures live in
    // `os.tmpdir()` — otherwise every assertion below quietly depends on how
    // full the machine running it happens to be.
    freePercentOf: async () => 100,
  })
  const jobId = engine.start({ fromLocationId: roots.from.id, toLocationId: roots.to.id })
  onFirstCopy?.(engine, jobId)
  for (let i = 0; i < 400; i++) {
    const job = engine.list().find((j) => j.jobId === jobId)
    if (job && job.state !== 'running' && job.state !== 'queued') return job.state
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('drain never finished')
}

/** One hour row as this suite reads it back: who is charged, and for how much. */
interface HourAccount {
  readonly locationId: string
  readonly segments: number
  readonly bytes: number
}

/**
 * What the durable table says about `HOUR0` after a RESTART — the read that
 * used to answer with the drained root.
 *
 * An account, not a file list. Since D523 no boot can rebuild an index out of
 * this table, so the only question a cold process may put to it is "which
 * location is this hour charged to, and for how much"; the directory answers
 * the rest, and these tests check the directory separately, on disk.
 */
async function durableHours(store: SettingsStoreClient): Promise<readonly HourAccount[]> {
  const restarted = new SegmentHourLedger({ store, logger: silentLogger() })
  await restarted.declare()
  await restarted.load()
  return restarted
    .snapshot()
    .filter((row) => row.deviceId === DEVICE && row.hourStartMs === HOUR0)
    .map((row) => ({ locationId: row.locationId, segments: row.segments, bytes: row.bytes }))
    .toSorted((a, b) => a.locationId.localeCompare(b.locationId))
}

/** What `seedHour` wrote, summed the way an hour row accounts for it. */
function accountOf(rows: readonly SegmentRow[], locationId: string): HourAccount {
  return {
    locationId,
    segments: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  }
}

describe('relocation re-points the durable hour index, not only RAM', () => {
  it('a drained hour is charged to its NEW location after a restart, and the files are there', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, HOUR0, 3)
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = new SegmentHourLedger({
      store,
      logger: silentLogger(),
      listHour: listerOver(roots),
    })
    await ledger.declare()
    for (const row of rows) await ledger.recordSegment(row)

    expect(await runDrain(roots, index, ledger)).toBe('done')

    // The cold read. The whole hour is charged to the target, and the source
    // row is GONE rather than left at zero — an emptied row that survives is
    // the ghost this exists to end.
    expect(await durableHours(store)).toEqual([accountOf(rows, roots.to.id)])
    for (const row of rows) {
      // And the location the account names actually HOLDS the bytes.
      expect(existsSync(path.join(roots.to.root, row.path))).toBe(true)
      expect(existsSync(path.join(roots.from.root, row.path))).toBe(false)
    }
  })

  it('deletes the source bytes only AFTER the durable re-point has landed', async () => {
    // The ledger cannot refuse a re-point any more — since D523 a row is ten
    // scalars the mirror always holds, so there is no fallible read to fail —
    // and what is left to pin is the ORDER the mover works in, the half of
    // D291 the engine owns: copy, verify, re-point durably, and only THEN
    // unlink the source. A crash at any instant of that leaves the hour
    // charged to a location that holds the files. Unlinking first leaves
    // footage charged to a root it has already left.
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, HOUR0, 3)
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const real = new SegmentHourLedger({
      store,
      logger: silentLogger(),
      listHour: listerOver(roots),
    })
    await real.declare()
    for (const row of rows) await real.recordSegment(row)

    /** Per moved row: was the SOURCE still on disk when the durable write ran? */
    const sourceHeldAtRepoint: boolean[] = []
    const observing: RelocateHourLedger = {
      census: (scope) => real.census(scope),
      streamSegments: (scope) => real.streamSegments(scope),
      dropSegments: (dropped) => real.dropSegments(dropped),
      repointSegments: async (
        moved: readonly RelocatedSegment[],
        toLocationId: string,
      ): Promise<void> => {
        for (const row of moved)
          sourceHeldAtRepoint.push(existsSync(path.join(roots.from.root, row.fromPath ?? row.path)))
        await real.repointSegments(moved, toLocationId)
      },
    }

    expect(await runDrain(roots, index, observing)).toBe('done')

    // Three rows, and at the instant each was re-pointed BOTH locations held it.
    expect(sourceHeldAtRepoint).toEqual([true, true, true])
    // The source is emptied only afterwards, and the account went with the bytes.
    for (const row of rows) {
      expect(existsSync(path.join(roots.from.root, row.path))).toBe(false)
      expect(index.segments(DEVICE).find((s) => s.path === row.path)?.locationId).toBe(roots.to.id)
    }
    expect(await durableHours(store)).toEqual([accountOf(rows, roots.to.id)])
  })

  it('a cancel inside an hour leaves that hour WHOLLY readable at the source', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, HOUR0, 4)
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = new SegmentHourLedger({
      store,
      logger: silentLogger(),
      listHour: listerOver(roots),
    })
    await ledger.declare()
    for (const row of rows) await ledger.recordSegment(row)

    const state = await runDrain(roots, index, ledger, (engine, jobId) => {
      // Cancel while the hour's files are still being copied.
      setTimeout(() => engine.cancel(jobId), 0)
    })
    expect(state).toBe('cancelled')

    for (const row of rows) {
      expect(existsSync(path.join(roots.from.root, row.path))).toBe(true)
      expect(index.segments(DEVICE).find((s) => s.path === row.path)?.locationId).toBe(
        roots.from.id,
      )
    }
    // And the hour is still charged, WHOLE, to the location that still holds
    // it: a cancel mid-hour must not leave a fraction of the account stranded
    // at a target that has no files of its own yet.
    expect(await durableHours(store)).toEqual([accountOf(rows, roots.from.id)])
  })

  it('a source already gone is out of the mover reach — the stranded copy survives, and the WALK settles the account', async () => {
    const roots = makeRoots()
    const rows = seedHour(roots.from.root, roots.from.id, HOUR0, 2)
    const index = new RecordingIndex()
    index.hydrateDevice(
      DEVICE,
      roots.from.id,
      rows.map((r) => r.path),
    )
    const store = fakeStore()
    const ledger = new SegmentHourLedger({
      store,
      logger: silentLogger(),
      listHour: listerOver(roots),
    })
    await ledger.declare()
    for (const row of rows) await ledger.recordSegment(row)

    // The crash window a previous run left behind: bytes copied and verified
    // at the target, source removed, re-point never landed.
    //
    // Until D523 the mover met this row itself — the durable `paths` column
    // named a file the source no longer had, `copyVerified` adopted the
    // equal-sized copy at the target, and the hour was re-pointed. The work
    // list is a LISTING of the source directory now, so a file that is not
    // there is not in it: the mover never hears about this segment at all.
    // What must still hold is that nothing DESTROYS it — the stranded copy
    // stays, and the stale account is a repair for the hour walk, which asks
    // each directory what it holds.
    const stranded = rows[0]!
    const dst = path.join(roots.to.root, stranded.path)
    mkdirSync(path.dirname(dst), { recursive: true })
    writeFileSync(dst, readFileSync(path.join(roots.from.root, stranded.path)))
    const { rmSync } = await import('node:fs')
    rmSync(path.join(roots.from.root, stranded.path))

    expect(await runDrain(roots, index, ledger)).toBe('done')

    // Both files are at the target: the one the drain moved, and the one a
    // previous run stranded there. Nothing deleted the stranded copy and
    // nothing forgot it.
    for (const row of rows) expect(existsSync(path.join(roots.to.root, row.path))).toBe(true)
    // The accounts are what the drain could see: the moved segment charged to
    // the target, and the stranded one still charged to a source hour whose
    // directory is now empty.
    expect(await durableHours(store)).toEqual([
      accountOf([rows[0]!], roots.from.id),
      accountOf([rows[1]!], roots.to.id),
    ])

    // And that is a repair, not a loss. The hour walk lists both directories
    // and settles it: the target hour's aggregate is REPLACED by its listing
    // (two files, 201 bytes), and the empty source hour is forgotten outright
    // — `adoptWalkedHour` refuses an empty listing on purpose, because "the
    // walk found nothing" is also what an unmounted root looks like.
    const listing = await listerOver(roots)(roots.to.id, DEVICE, 'high', HOUR0)
    expect(listing).toHaveLength(2)
    await ledger.adoptWalkedHour(DEVICE, 'high', roots.to.id, HOUR0, listing ?? [])
    expect(await ledger.forgetHour(DEVICE, 'high', roots.from.id, HOUR0)).toBe(1)
    expect(await durableHours(store)).toEqual([accountOf(rows, roots.to.id)])
  })
})

describe('SegmentHourLedger.repointSegments ordering', () => {
  it('never leaves a segment accounted NOWHERE — the target row is written before the source row is shrunk', async () => {
    const store = fakeStore()
    // Every durable write, in order, as the store saw it. Replaying it is how
    // an INSTANT is asserted rather than an end state: the end state of both
    // orderings is identical, and only one of them has a moment in which the
    // hour's two segments are charged to nobody. A crash there loses that much
    // of the account for good — the table is the authority for HOW MUCH, and
    // no later directory walk of the SOURCE hour can put back what the row
    // stopped claiming (D291).
    const writes: { key: string; segments: number | null }[] = []
    const observedStore = {
      ...store,
      set: {
        mutate: async (input: {
          collection: string
          key: string
          value: Record<string, unknown>
        }): Promise<void> => {
          writes.push({ key: input.key, segments: Number(input.value['segments']) })
          await store.set.mutate(input)
        },
      },
      delete: {
        mutate: async (input: { collection: string; key: string }): Promise<void> => {
          writes.push({ key: input.key, segments: null })
          await store.delete.mutate(input)
        },
      },
    } as unknown as SettingsStoreClient

    const ledger = new SegmentHourLedger({ store: observedStore, logger: silentLogger() })
    await ledger.declare()
    const rows = seedHour(mkdtempSync(path.join(tmpdir(), 'ord-')), 'recordings:spindle', HOUR0, 2)
    for (const row of rows) await ledger.recordSegment(row)

    const moved = rows[0]!
    writes.length = 0
    await ledger.repointSegments([moved], 'recordings:ssd')
    expect(writes.length).toBeGreaterThan(1)

    // Replay every prefix. Both files are still on disk throughout — the mover
    // unlinks nothing until this returns — so after EVERY durable write the
    // rows together must still account for both of them.
    const sourceKey = `102|high|recordings:spindle|${HOUR0}`
    const targetKey = `102|high|recordings:ssd|${HOUR0}`
    const state = new Map<string, number>([[sourceKey, rows.length]])
    for (const write of writes) {
      if (write.segments === null) state.delete(write.key)
      else state.set(write.key, write.segments)
      const accounted = [...state.values()].reduce((sum, n) => sum + n, 0)
      expect(accounted).toBeGreaterThanOrEqual(rows.length)
    }
    // And the moved segment ends up charged to the target only.
    expect([...state.entries()].toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
      [sourceKey, 1],
      [targetKey, 1],
    ])
  })
})
