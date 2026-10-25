/**
 * The ARCHIVE is the ledger; the RAM index answers only about what is RESIDENT
 * (D295).
 *
 * ## Why the fixture is asymmetric, and why that is the whole test
 *
 * Every one of these cases builds an index holding a FRACTION of an archive the
 * ledger holds in full — because a fixture in which the two agree is exactly
 * what let the defect ship. On 2026-08-29 a storage migration drained
 * `recordingsLow:default`, took its work list from
 * `index.segmentsOnLocation(from.id)`, processed the 29 218 row slots the whole
 * index held, and reported `done`. The ledger held 145 664 segments / 80.3 GB
 * on that one location. Nothing logged a discrepancy: a partial answer and a
 * complete one are the same array.
 *
 * So the assertions here are all of the same shape — **the operation sees the
 * LEDGER's count, not the index's** — plus the one thing that makes the class
 * detectable at all: an operation that finishes short SAYS SO.
 *
 * ## What D523 changed in the fixture, and what it did not
 *
 * Nothing about the subject. The aggregate surfaces these cases lean on
 * (`census`, `profilesWithFootage`) still answer from the table, unchanged, and
 * the "sees 18 where the index sees 3" assertions are the same numbers.
 *
 * What moved is where the file NAMES come from: `streamSegments` no longer
 * reads a `paths` column, it LISTS each chosen hour directory. So the fixture
 * now has to stand in for the array as well as the table — {@link hourListerOf}
 * — and a test that plants no files on disk serves the listing from the rows it
 * seeded. Without one the stream yields nothing at all, which is precisely the
 * silence D523 made impossible to mistake for an empty scope.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createDurableState,
  type IScopedLogger,
  type LogExtras,
  type SettingsStoreClient,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import { RelocateEngine } from '../../relocate-engine.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentStore } from '../../segment-store.js'
import type { SegmentRow } from '../../types.js'
import { saveDeviceConfig } from '../config-store.js'
import { PlacementService } from '../placement-service.js'
import {
  EMPTY_PLACEMENT,
  RECORDING_PLACEMENT_KEY,
  type RecordingPlacementBlob,
  RecordingPlacementBlobSchema,
} from '../placement-store.js'
import { buildRecordingProvider, type RecordingProviderDeps } from '../recording-provider.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../roots.js'
import {
  ARCHIVE_HOUR_PAGE,
  type HourLister,
  RECORDING_SEGMENT_HOURS_COLLECTION,
  SegmentHourLedger,
} from '../segment-hour-ledger.js'
import { makeConfigsState } from './configs-state-fixture.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS
const DEVICE = 102

interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly msg: string
  readonly extras: LogExtras | undefined
}

function capturingLogger(sink: CapturedLog[]): IScopedLogger {
  const at =
    (level: CapturedLog['level']) =>
    (msg: string, extras?: LogExtras): void => {
      sink.push({ level, msg, extras })
    }
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return logger as unknown as IScopedLogger
}

interface StoreFilter {
  readonly where?: Record<string, unknown>
  readonly whereIn?: Record<string, readonly unknown[]>
  readonly whereBetween?: Record<string, readonly [unknown, unknown]>
  readonly orderBy?: { readonly field: string; readonly direction: 'asc' | 'desc' }
  readonly limit?: number
  readonly offset?: number
}

interface AggregateField {
  readonly as: string
  readonly field: string
  readonly op: 'sum' | 'min' | 'max'
}

interface StoreInput {
  readonly collection: string
  readonly key?: string
  readonly value?: Record<string, unknown>
  readonly filter?: StoreFilter
  readonly columns?: readonly string[]
  readonly fields?: readonly AggregateField[]
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function matches(data: Record<string, unknown>, id: string, filter?: StoreFilter): boolean {
  const valueOf = (field: string): unknown => (field === 'key' ? id : data[field])
  for (const [field, want] of Object.entries(filter?.where ?? {})) {
    if (valueOf(field) !== want) return false
  }
  for (const [field, wanted] of Object.entries(filter?.whereIn ?? {})) {
    if (!wanted.includes(valueOf(field))) return false
  }
  for (const [field, [lo, hi]] of Object.entries(filter?.whereBetween ?? {})) {
    const v = numberOf(valueOf(field))
    if (v === null) return false
    if (typeof lo === 'number' && v < lo) return false
    if (typeof hi === 'number' && v > hi) return false
  }
  return true
}

/**
 * A store that HONOURS every predicate the archive reads depend on, and records
 * what it was asked.
 *
 * A fake that ignored `limit`/`orderBy`/`whereBetween` would make a caller
 * asking for one bounded page indistinguishable from one fetching the whole
 * collection — which is the second half of what this file exists to pin.
 */
function recordingStore(ops: StoreInput[]): SettingsStoreClient {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const ensure = (collection: string): Map<string, Record<string, unknown>> => {
    let m = tables.get(collection)
    if (!m) {
      m = new Map()
      tables.set(collection, m)
    }
    return m
  }
  const selected = (input: StoreInput): { id: string; data: Record<string, unknown> }[] => {
    let rows = [...ensure(input.collection).entries()]
      .filter(([id, data]) => matches(data, id, input.filter))
      .map(([id, data]) => ({ id, data }))
    const orderBy = input.filter?.orderBy
    if (orderBy) {
      const dir = orderBy.direction === 'desc' ? -1 : 1
      rows = rows.toSorted(
        (a, b) =>
          dir * ((numberOf(a.data[orderBy.field]) ?? 0) - (numberOf(b.data[orderBy.field]) ?? 0)),
      )
    }
    const offset = input.filter?.offset ?? 0
    const limit = input.filter?.limit
    rows = rows.slice(offset, limit === undefined ? undefined : offset + limit)
    const columns = input.columns
    if (columns === undefined) return rows
    return rows.map(({ id, data }) => {
      const projected: Record<string, unknown> = {}
      for (const c of columns) projected[c] = data[c]
      return { id, data: projected }
    })
  }
  const client = {
    declareCollection: {
      mutate: async (input: StoreInput) => {
        ops.push(input)
        ensure(input.collection)
      },
    },
    set: {
      mutate: async (input: StoreInput) => {
        ops.push(input)
        ensure(input.collection).set(input.key ?? '', input.value ?? {})
      },
    },
    delete: {
      mutate: async (input: StoreInput) => {
        ops.push(input)
        ensure(input.collection).delete(input.key ?? '')
      },
    },
    query: {
      query: async (input: StoreInput) => {
        ops.push(input)
        return selected(input)
      },
    },
    aggregate: {
      query: async (input: StoreInput) => {
        ops.push(input)
        const rows = selected({ ...input, filter: { ...input.filter, limit: undefined } })
        const values: Record<string, number | null> = {}
        for (const f of input.fields ?? []) {
          const nums = rows.map((r) => numberOf(r.data[f.field])).filter((n) => n !== null)
          if (nums.length === 0) {
            values[f.as] = null
            continue
          }
          values[f.as] =
            f.op === 'sum'
              ? nums.reduce((a, b) => a + b, 0)
              : f.op === 'min'
                ? Math.min(...nums)
                : Math.max(...nums)
        }
        return { count: rows.length, values }
      },
    },
  }
  return client as unknown as SettingsStoreClient
}

/** One 10 s segment row, with its bytes written under `root` when given. */
function seedSegment(
  root: string | null,
  locationId: string,
  startMs: number,
  profile = 'high',
): SegmentRow {
  const bytes = 100
  const rel = segmentRelPath(DEVICE, profile, startMs, 10_000, bytes)
  if (root !== null) {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, Buffer.alloc(bytes, 7))
  }
  return { deviceId: DEVICE, profile, startMs, durMs: 10_000, bytes, path: rel, locationId }
}

/**
 * `hours` hours of `perHour` segments each, all on `locationId`.
 *
 * Every row goes into the LEDGER. Only the rows of the last `residentHours`
 * hours go into the INDEX — the post-D287 shape: the live tail is
 * write-through, everything older is hydrated only if somebody looked at it.
 */
interface PartialIndexOptions {
  readonly root: string | null
  readonly locationId: string
  readonly hours: number
  readonly perHour: number
  readonly residentHours: number
  readonly firstHourMs?: number
}

interface PartialIndexFixture {
  readonly index: RecordingIndex
  readonly ledger: SegmentHourLedger
  /** The same store the fixture's ledger writes to — so a test can boot a
   *  SECOND real ledger over the identical archive. */
  readonly store: SettingsStoreClient
  readonly ops: StoreInput[]
  readonly rows: readonly SegmentRow[]
  readonly logs: CapturedLog[]
}

/** The location-relative hour bucket a segment of this hour lives in. */
function hourDirOf(deviceId: number, profile: string, hourStartMs: number): string {
  return path.posix.dirname(segmentRelPath(deviceId, profile, hourStartMs, 0, 0))
}

/**
 * How phase two of a ledger read reaches the array (D523).
 *
 * With a planted root it is a real `readdir` of the hour bucket, so a drain
 * that has already MOVED an hour's files sees them gone, exactly as production
 * would. With no root — the prune cases, which never write a byte — the
 * listing is served from the rows the fixture seeded, because the subject
 * there is ledger-versus-index and not disk-versus-ledger.
 */
function hourListerOf(root: string | null, rows: readonly SegmentRow[]): HourLister {
  return async (_locationId, deviceId, profile, hourStartMs) => {
    const dir = hourDirOf(deviceId, profile, hourStartMs)
    // `rows` is the fixture's live array — read at call time, never snapshotted
    // at construction, or a lister built before the seeding would list nothing.
    if (root === null) return rows.map((r) => r.path).filter((p) => p.startsWith(`${dir}/`))
    try {
      return readdirSync(path.join(root, dir)).map((name) => `${dir}/${name}`)
    } catch {
      // The bucket is not there: an hour that holds nothing, which is what an
      // already-drained hour looks like. A REFUSAL would be `null`.
      return []
    }
  }
}

async function partialIndexFullLedger(opts: PartialIndexOptions): Promise<PartialIndexFixture> {
  const logs: CapturedLog[] = []
  const ops: StoreInput[] = []
  const store = recordingStore(ops)
  const rows: SegmentRow[] = []
  const ledger = new SegmentHourLedger({
    store,
    logger: capturingLogger(logs),
    listHour: hourListerOf(opts.root, rows),
  })
  await ledger.declare()
  const index = new RecordingIndex()
  const first = opts.firstHourMs ?? HOUR0
  for (let h = 0; h < opts.hours; h++) {
    for (let i = 0; i < opts.perHour; i++) {
      const row = seedSegment(opts.root, opts.locationId, first + h * HOUR_MS + i * 10_000)
      rows.push(row)
      await ledger.recordSegment(row)
      if (h >= opts.hours - opts.residentHours) index.addSegment(row)
    }
  }
  ops.length = 0
  return { index, ledger, store, ops, rows, logs }
}

const archiveQueries = (ops: readonly StoreInput[]): readonly StoreInput[] =>
  ops.filter((o) => o.collection === RECORDING_SEGMENT_HOURS_COLLECTION)

describe('the relocate mover drains the ARCHIVE, not the resident index', () => {
  it('moves every segment the LEDGER holds on the source, not the few the index does', async () => {
    const fromRoot = mkdtempSync(path.join(tmpdir(), 'arch-from-'))
    const toRoot = mkdtempSync(path.join(tmpdir(), 'arch-to-'))
    const from: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordingsLow:default', type: 'recordingsLow', root: fromRoot },
      'active',
    )
    const to: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordingsLow:ssd', type: 'recordingsLow', root: toRoot },
      'active',
    )
    const h = await partialIndexFullLedger({
      root: fromRoot,
      locationId: from.id,
      hours: 6,
      perHour: 3,
      residentHours: 1,
    })
    // The fixture's whole point, stated: 3 of 18.
    expect(h.index.segmentsOnLocation(from.id)).toHaveLength(3)
    expect((await h.ledger.census({ locationId: from.id }))?.segments).toBe(18)

    const logs: CapturedLog[] = []
    const engine = new RelocateEngine({
      index: h.index,
      locations: () => [from, to],
      ledger: () => h.ledger,
      logger: capturingLogger(logs),
      now: () => Date.now(),
      newId: () => 'job-1',
      sleep: async () => {},
      freePercentOf: async () => 100,
    })
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: to.id })
    await settled(engine, jobId)

    const job = engine.list().find((j) => j.jobId === jobId)
    expect(job?.state).toBe('done')
    // THE assertion. Reverting the work list to `index.segmentsOnLocation`
    // makes this 3 — and the job still reports `done`, which is the defect.
    expect(job?.filesMoved).toBe(18)
    // And the M the operator reads is the archive's, not the index's.
    expect(job?.filesTotal).toBe(18)
    for (const row of h.rows) {
      expect(existsSync(path.join(toRoot, row.path))).toBe(true)
      expect(existsSync(path.join(fromRoot, row.path))).toBe(false)
    }
    // A drain that emptied the source says so, with the numbers on it.
    const done = logs.find((l) => l.msg.includes('source scope is empty'))
    expect(done?.extras?.meta).toMatchObject({ archiveSegments: 18, moved: 18 })
  })

  it('reads the ledger one BOUNDED page at a time — never the whole collection', async () => {
    const fromRoot = mkdtempSync(path.join(tmpdir(), 'arch-page-from-'))
    const toRoot = mkdtempSync(path.join(tmpdir(), 'arch-page-to-'))
    const from: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordings:spindle', type: 'recordings', root: fromRoot },
      'active',
    )
    const to: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordings:ssd', type: 'recordings', root: toRoot },
      'active',
    )
    const h = await partialIndexFullLedger({
      root: fromRoot,
      locationId: from.id,
      hours: 5,
      perHour: 2,
      residentHours: 0,
    })

    const engine = new RelocateEngine({
      index: h.index,
      locations: () => [from, to],
      ledger: () => h.ledger,
      logger: capturingLogger([]),
      now: () => Date.now(),
      newId: () => 'job-1',
      sleep: async () => {},
      freePercentOf: async () => 100,
    })
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: to.id })
    await settled(engine, jobId)

    // THE assertion, and it is about the QUESTION, not the answer: the boot
    // query D287 deleted was one unbounded fetch of this exact collection, and
    // at 30 TB it is ~460 MB. Every read this job issued is either an
    // aggregate, a keyed point read, or an ordered page no larger than
    // ARCHIVE_HOUR_PAGE.
    for (const q of archiveQueries(h.ops)) {
      if (q.fields !== undefined) continue // aggregate: no rows come back
      if (q.value !== undefined || q.key !== undefined) continue // set/delete
      const filter = q.filter
      expect(filter).toBeDefined()
      const keyed = filter?.whereIn?.['key'] !== undefined
      const bounded = filter?.limit !== undefined && filter.limit <= ARCHIVE_HOUR_PAGE
      expect(keyed || bounded).toBe(true)
    }
    expect(engine.list().find((j) => j.jobId === jobId)?.filesMoved).toBe(10)
  })

  it('SHOUTS when the source is not empty at the end — a fraction moved is not "done"', async () => {
    const fromRoot = mkdtempSync(path.join(tmpdir(), 'arch-short-from-'))
    const toRoot = mkdtempSync(path.join(tmpdir(), 'arch-short-to-'))
    const from: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordings:spindle', type: 'recordings', root: fromRoot },
      'active',
    )
    const to: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordings:ssd', type: 'recordings', root: toRoot },
      'active',
    )
    const h = await partialIndexFullLedger({
      root: fromRoot,
      locationId: from.id,
      hours: 4,
      perHour: 2,
      residentHours: 0,
    })
    // A REAL second ledger over the identical archive whose array cannot be
    // read: every hour directory answers `null` — "could not ask", which is
    // never "holds nothing" — so the stream skips every hour and yields not one
    // segment, while the census still reports all 8 out of the table. That is
    // the post-D523 shape of a job that walks SHORT, and the question is
    // whether the mover admits it instead of reporting `done` over an archive
    // it never saw. (Before D523 the same shape came from a ledger that refused
    // every re-point; that refusal no longer exists — `repointSegments` is
    // arithmetic over a row the mirror always holds.)
    const blindLogs: CapturedLog[] = []
    const blind = new SegmentHourLedger({
      store: h.store,
      logger: capturingLogger(blindLogs),
      listHour: async () => null,
    })
    await blind.declare()
    await blind.load()
    const logs: CapturedLog[] = []
    const engine = new RelocateEngine({
      index: h.index,
      locations: () => [from, to],
      ledger: () => blind,
      logger: capturingLogger(logs),
      now: () => Date.now(),
      newId: () => 'job-1',
      sleep: async () => {},
      freePercentOf: async () => 100,
    })
    const jobId = engine.start({ fromLocationId: from.id, toLocationId: to.id })
    await settled(engine, jobId)

    expect(engine.list().find((j) => j.jobId === jobId)?.filesMoved).toBe(0)
    // And the ledger itself named every hour it could not read, per camera — a
    // branch that drops work silently reads as "there was nothing there".
    const skipped = blindLogs.filter((l) => l.msg.includes('hour directory could not be listed'))
    expect(skipped).toHaveLength(4)
    expect(skipped[0]?.extras?.tags).toEqual({ deviceId: DEVICE })
    const shout = logs.find((l) => l.msg.includes('the source is NOT empty'))
    expect(shout?.level).toBe('warn')
    expect(shout?.extras?.meta).toMatchObject({
      archiveSegments: 8,
      moved: 0,
      remainingSegments: 8,
    })
  })
})

describe('pruneFootage selects from the ARCHIVE', () => {
  it('deletes every expired segment the LEDGER holds, not only the resident ones', async () => {
    const nowMs = Date.now()
    // Six hours ending 30 days ago: every segment is past a 7-day policy.
    const firstHourMs = Math.floor((nowMs - 30 * DAY_MS) / HOUR_MS) * HOUR_MS
    const h = await partialIndexFullLedger({
      root: null,
      locationId: 'loc-a',
      hours: 6,
      perHour: 3,
      residentHours: 1,
      firstHourMs,
    })
    expect(h.index.segments(DEVICE)).toHaveLength(3)

    const evicted: SegmentRow[] = []
    const logs: CapturedLog[] = []
    const locations: RecordingsLocation[] = [
      recordingsLocationOfMode({ id: 'loc-a', type: 'recordings', root: '/tmp/x' }, 'active'),
    ]
    const configStore = await makeConfigsState()
    await saveDeviceConfig(configStore, DEVICE, {
      enabled: true,
      bands: [],
      retention: { maxAgeDays: 7 },
    })
    const deps: RecordingProviderDeps = {
      index: h.index,
      segmentStore: {
        evict: async (_locationId: string, rows: readonly SegmentRow[]): Promise<number> => {
          evicted.push(...rows)
          return rows.reduce((sum, r) => sum + r.bytes, 0)
        },
      } as unknown as SegmentStore,
      nodeId: 'node-1',
      dataDir: '/tmp/rec',
      playbackBaseUrl: () => 'http://127.0.0.1/playback',
      logger: capturingLogger(logs),
      configStore,
      locations: () => locations,
      refreshLocations: async () => locations,
      capacity: async () => ({ availableBytes: null, totalBytes: null }),
      archive: () => h.ledger,
      hydrateDevice: async () => {},
    }

    const out = await buildRecordingProvider(deps).pruneFootage({ deviceId: DEVICE })

    // THE assertion. Pointing the selection back at `deps.index.segments`
    // makes this 3 — and `pruneFootage` still returns a floor and an
    // `itemsAffected` that read exactly like a complete prune.
    expect(evicted).toHaveLength(18)
    expect(out.deletedBuckets).toBe(18)
    const pass = logs.find((l) => l.msg.includes('retention prune pass'))
    expect(pass?.extras?.tags).toEqual({ deviceId: DEVICE })
    expect(pass?.extras?.meta).toMatchObject({ archiveSegments: 18, selected: 18 })
  })

  it('REFUSES to prune at all when this node has no archive — it never falls back to the resident index', async () => {
    const nowMs = Date.now()
    const firstHourMs = Math.floor((nowMs - 30 * DAY_MS) / HOUR_MS) * HOUR_MS
    const h = await partialIndexFullLedger({
      root: null,
      locationId: 'loc-a',
      hours: 6,
      perHour: 3,
      residentHours: 1,
      firstHourMs,
    })
    const evicted: SegmentRow[] = []
    const logs: CapturedLog[] = []
    const locations: RecordingsLocation[] = [
      recordingsLocationOfMode({ id: 'loc-a', type: 'recordings', root: '/tmp/x' }, 'active'),
    ]
    const configStore = await makeConfigsState()
    await saveDeviceConfig(configStore, DEVICE, {
      enabled: true,
      bands: [],
      retention: { maxAgeDays: 7 },
    })
    const deps: RecordingProviderDeps = {
      index: h.index,
      segmentStore: {
        evict: async (_locationId: string, rows: readonly SegmentRow[]): Promise<number> => {
          evicted.push(...rows)
          return 0
        },
      } as unknown as SegmentStore,
      nodeId: 'node-1',
      dataDir: '/tmp/rec',
      playbackBaseUrl: () => 'http://127.0.0.1/playback',
      logger: capturingLogger(logs),
      configStore,
      locations: () => locations,
      refreshLocations: async () => locations,
      capacity: async () => ({ availableBytes: null, totalBytes: null }),
      hydrateDevice: async () => {},
    }

    const out = await buildRecordingProvider(deps).pruneFootage({ deviceId: DEVICE })

    // Deleting the three resident rows would look like a working prune and
    // move the reported floor. Nothing is deleted, and the refusal is said.
    expect(evicted).toEqual([])
    expect(out).toEqual({ floorMs: null, deletedBuckets: 0, reclaimedBytes: 0 })
    expect(logs.find((l) => l.msg.includes('retention prune SKIPPED'))?.level).toBe('warn')
  })
})

/**
 * One camera, two profiles, ONE of them resident.
 *
 * `high` is the live tail — write-through, still in the index. `low` was
 * finalized hours ago and nobody has hydrated that window since boot, so since
 * D287 the index holds not one of its rows. Both are in the ledger, because the
 * footage is on the disk either way.
 *
 * This is the shape a fixture where index and ledger AGREE cannot express, and
 * agreeing fixtures are what let this whole family ship.
 */
async function twoProfilesOneResident(): Promise<{
  readonly index: RecordingIndex
  readonly ledger: SegmentHourLedger
}> {
  const logs: CapturedLog[] = []
  const ledger = new SegmentHourLedger({
    store: recordingStore([]),
    logger: capturingLogger(logs),
  })
  await ledger.declare()
  const index = new RecordingIndex()
  for (let i = 0; i < 3; i += 1) {
    const hot = seedSegment(null, LOW_LOCATION.id, HOUR0 + 5 * HOUR_MS + i * 10_000, 'high')
    await ledger.recordSegment(hot)
    index.addSegment(hot)
    // The ledger only: the hour is closed and unhydrated.
    await ledger.recordSegment(seedSegment(null, LOW_LOCATION.id, HOUR0 + i * 10_000, 'low'))
  }
  return { index, ledger }
}

const LOW_LOCATION: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordingsLow:ssd', type: 'recordingsLow', root: '/mnt/ssd' },
  'active',
)
const HIGH_LOCATION: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/mnt/hdd' },
  'active',
)

/** A placement service over an in-memory blob, and the blob. */
function placementOver(seed: Readonly<Record<string, string>>): {
  readonly service: PlacementService
  readonly stored: () => Readonly<Record<string, string>>
} {
  const blob: Record<string, unknown> = {
    [RECORDING_PLACEMENT_KEY]: {
      assignments: { ...seed },
      volumeIds: {},
    },
  }
  const state = createDurableState<RecordingPlacementBlob>({
    key: RECORDING_PLACEMENT_KEY,
    schema: RecordingPlacementBlobSchema,
    fallback: EMPTY_PLACEMENT,
    read: async () => ({ ...blob }),
    write: async (patch) => {
      Object.assign(blob, patch)
    },
  })
  const markers = new Map<string, { locationId: string; volumeId: string }>()
  const service = new PlacementService({
    logger: capturingLogger([]),
    locations: () => [HIGH_LOCATION, LOW_LOCATION],
    state,
    opsLog: { append: async () => undefined, list: async () => [] },
    probe: {
      readMarker: async (root) => markers.get(root) ?? null,
      writeMarker: async (root, marker) => {
        markers.set(root, marker)
      },
      newVolumeId: () => 'vol-1',
    },
    capacityFor: async () => ({ availableBytes: 1_000_000_000, totalBytes: 1_000_000_000 }),
    usedOnLocation: async () => 0,
  })
  return {
    service,
    stored: () => {
      const parsed = RecordingPlacementBlobSchema.safeParse(blob[RECORDING_PLACEMENT_KEY])
      return parsed.success ? parsed.data.assignments : {}
    },
  }
}

describe('the placement work set comes from the ARCHIVE, not the resident index (D295 §3a #9)', () => {
  it('the index has forgotten a profile the ledger still holds', async () => {
    const h = await twoProfilesOneResident()

    // Stated, so a later change that makes the two agree fails HERE rather than
    // quietly turning every assertion below into a tautology.
    expect([...h.index.accountingByProfile(DEVICE).keys()]).toEqual(['high'])
    expect(
      [...(h.ledger.profilesWithFootage(new Set([DEVICE])).get(DEVICE) ?? [])].toSorted(),
    ).toEqual(['high', 'low'])
  })

  it('a work set derived from the index never plans the cold profile', async () => {
    const h = await twoProfilesOneResident()
    const { service } = placementOver({})

    const work = [...h.index.accountingByProfile(DEVICE).keys()]
      .filter((p) => p === 'high' || p === 'mid' || p === 'low')
      .map((profile) => ({ deviceId: DEVICE, profile }))
    const plan = await service.recompute(work)

    // What was LOST: not a count, a named key. `102:low` has footage on the
    // disk and no plan at all.
    expect(plan.assignments.has(`${DEVICE.toString()}:high`)).toBe(true)
    expect(plan.assignments.has(`${DEVICE.toString()}:low`)).toBe(false)
  })

  it('a work set derived from the LEDGER plans it', async () => {
    const h = await twoProfilesOneResident()
    const { service, stored } = placementOver({})

    const work = [...(h.ledger.profilesWithFootage(new Set([DEVICE])).get(DEVICE) ?? [])]
      .filter((p) => p === 'high' || p === 'mid' || p === 'low')
      .map((profile) => ({ deviceId: DEVICE, profile }))
    const plan = await service.recompute(work)

    expect(plan.assignments.get(`${DEVICE.toString()}:low`)).toBe(LOW_LOCATION.id)
    expect(stored()[`${DEVICE.toString()}:low`]).toBe(LOW_LOCATION.id)
  })

  it('the pass does not delete the assignment of a profile it did not plan', async () => {
    // The write used to REPLACE the whole record with the plan, so a key absent
    // from a work set derived from the resident index was deleted outright on
    // the next tick that changed anything. Assert what must NOT be lost.
    const h = await twoProfilesOneResident()
    const { service, stored } = placementOver({
      [`${DEVICE.toString()}:low`]: LOW_LOCATION.id,
      '1439:low': LOW_LOCATION.id,
    })

    const work = [...h.index.accountingByProfile(DEVICE).keys()]
      .filter((p) => p === 'high' || p === 'mid' || p === 'low')
      .map((profile) => ({ deviceId: DEVICE, profile }))
    await service.recompute(work)

    expect(stored()[`${DEVICE.toString()}:low`]).toBe(LOW_LOCATION.id)
    expect(stored()['1439:low']).toBe(LOW_LOCATION.id)
    expect(stored()[`${DEVICE.toString()}:high`]).toBe(HIGH_LOCATION.id)
  })
})

/** Spin until a relocate job leaves `queued`/`running`. */
async function settled(engine: RelocateEngine, jobId: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const job = engine.list().find((j) => j.jobId === jobId)
    if (job && job.state !== 'running' && job.state !== 'queued') return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('relocate job never finished')
}
