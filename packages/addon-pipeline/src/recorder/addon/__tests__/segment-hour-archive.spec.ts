/**
 * The archive READ surface of the hour ledger — what it ASKS the store.
 *
 * ## Why these tests assert on the question and not on the answer
 *
 * A scan and a sum produce the same number. That is exactly how the defect
 * these replace survived: `RecordingIndex.accountingForLocations` visited every
 * one of ~7.1 M rows twice a minute and returned a total that was always
 * correct, and `segmentsOnLocations` copied and sorted the whole archive to
 * pick the oldest few and also returned the right rows. Any test comparing
 * totals passes both before and after. So these tests read the STORE OPS: one
 * `aggregate` where there used to be a scan, one bounded `orderBy … limit`
 * where there used to be a full sort.
 *
 * ## What D523 moved, and what it did not
 *
 * Phase one is untouched: the probe columns, the page size, the rule that it
 * stops CHOOSING and not merely PAGING, `exhausted`, the keyset cursor and the
 * page backstop are all exactly as they were, because they are the properties
 * of the ordered aggregate only the TABLE can answer.
 *
 * Phase two is different. There is no `paths` column any more, so the file
 * names come from a `readdir` of each chosen hour directory ({@link
 * HourLister}) — the directory is the authority for WHICH segments exist, the
 * table for HOW MUCH. The cost bound therefore moved from "how many rows were
 * staged into the mirror" to "how many hour directories were LISTED", and that
 * is what these tests now assert: only the hours phase one chose, never a
 * page's worth.
 *
 * And the one-shot `repairAggregates` backfill that used to live at the bottom
 * of this file is gone with the column it read: there is nothing left inside
 * the database to derive an aggregate FROM. A row written before the aggregate
 * columns existed reports zeros — it under-reports its disk, which prunes less
 * and never more — until a listing of that hour re-derives it exactly through
 * `adoptWalkedHour`. That repair is pinned in `segment-hour-seal.spec.ts`.
 */

import type { IScopedLogger, LogExtras, SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { selectEvictionsByBytes } from '../../evict-select.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentRow } from '../../types.js'
import {
  type HourLister,
  OLDEST_HOUR_PAGE,
  RECORDING_SEGMENT_HOURS_COLLECTION,
  SegmentHourLedger,
} from '../segment-hour-ledger.js'

const HOUR_MS = 3_600_000
const T0 = 1_700_000_000_000
const HOUR0 = Math.floor(T0 / HOUR_MS) * HOUR_MS

/** One store call, as the ledger issued it. */
interface StoreOp {
  readonly op: string
  readonly input: StoreInput
}

interface AggregateField {
  readonly as: string
  readonly field: string
  readonly op: 'sum' | 'min' | 'max'
}

interface StoreFilter {
  readonly where?: Record<string, unknown>
  readonly whereIn?: Record<string, readonly unknown[]>
  readonly orderBy?: { readonly field: string; readonly direction: 'asc' | 'desc' }
  readonly limit?: number
  readonly offset?: number
}

interface StoreInput {
  readonly collection: string
  readonly key?: string
  readonly value?: Record<string, unknown>
  readonly filter?: StoreFilter
  readonly columns?: readonly string[]
  readonly fields?: readonly AggregateField[]
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

/** One log line, as the ledger emitted it. */
interface CapturedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly msg: string
  readonly extras: LogExtras | undefined
}

function capturingLogger(sink: CapturedLine[]): IScopedLogger {
  const at =
    (level: CapturedLine['level']) =>
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

/** One `readdir` the ledger issued — the unit of cost phase two is bounded in. */
interface HourListingCall {
  readonly locationId: string
  readonly deviceId: number
  readonly profile: string
  readonly hourStartMs: number
}

/**
 * The ARRAY, as phase two now reads it (D523).
 *
 * The hour bucket is the unit: a listing hands back the names the directory
 * holds, and since a segment's NAME carries its start, duration and bytes that
 * is a complete description of the hour. Every call is recorded, because "how
 * many hour directories did this read touch" is exactly the term that used to
 * be "how many `paths` blobs did it fetch" — the thing a bounded read must not
 * let scale with the archive.
 */
interface VirtualDisk {
  readonly listHour: HourLister
  readonly listed: readonly HourListingCall[]
}

function hourBucketKey(
  locationId: string,
  deviceId: number,
  profile: string,
  hourStartMs: number,
): string {
  return `${locationId}|${deviceId}|${profile}|${hourStartMs}`
}

function virtualDisk(rows: readonly SegmentRow[]): VirtualDisk {
  const buckets = new Map<string, string[]>()
  for (const r of rows) {
    const hour = Math.floor(r.startMs / HOUR_MS) * HOUR_MS
    const key = hourBucketKey(r.locationId, r.deviceId, r.profile, hour)
    const held = buckets.get(key)
    if (held) held.push(r.path)
    else buckets.set(key, [r.path])
  }
  const listed: HourListingCall[] = []
  const listHour: HourLister = async (locationId, deviceId, profile, hourStartMs) => {
    listed.push({ locationId, deviceId, profile, hourStartMs })
    return buckets.get(hourBucketKey(locationId, deviceId, profile, hourStartMs)) ?? []
  }
  return { listHour, listed }
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function matches(data: Record<string, unknown>, id: string, filter?: StoreFilter): boolean {
  for (const [field, want] of Object.entries(filter?.where ?? {})) {
    if ((field === 'key' ? id : data[field]) !== want) return false
  }
  for (const [field, wanted] of Object.entries(filter?.whereIn ?? {})) {
    if (!wanted.includes(field === 'key' ? id : data[field])) return false
  }
  return true
}

/**
 * A store that RECORDS every call and honours the predicates the archive reads
 * depend on. It deliberately implements `orderBy`/`limit`/`offset` faithfully:
 * a fake that ignored them would let a caller that asks for everything look
 * exactly like one that asks for the oldest page — which is the whole subject.
 */
function recordingStore(ops: StoreOp[]): SettingsStoreClient {
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
        ops.push({ op: 'declareCollection', input })
        ensure(input.collection)
      },
    },
    set: {
      mutate: async (input: StoreInput) => {
        ops.push({ op: 'set', input })
        ensure(input.collection).set(input.key ?? '', input.value ?? {})
      },
    },
    delete: {
      mutate: async (input: StoreInput) => {
        ops.push({ op: 'delete', input })
        ensure(input.collection).delete(input.key ?? '')
      },
    },
    query: {
      query: async (input: StoreInput) => {
        ops.push({ op: 'query', input })
        return selected(input)
      },
    },
    aggregate: {
      query: async (input: StoreInput) => {
        ops.push({ op: 'aggregate', input })
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

function row(startMs: number, bytes: number, locationId: string, deviceId = 99): SegmentRow {
  return {
    deviceId,
    profile: 'high',
    startMs,
    durMs: 10_000,
    bytes,
    path: segmentRelPath(deviceId, 'high', startMs, 10_000, bytes),
    locationId,
  }
}

/** A ledger over a seeded archive, plus the two cost records these tests read:
 *  the store calls it issued and the hour directories it listed. */
interface SeededArchive {
  readonly ledger: SegmentHourLedger
  readonly ops: StoreOp[]
  readonly listed: readonly HourListingCall[]
}

async function seeded(rows: readonly SegmentRow[]): Promise<SeededArchive> {
  const ops: StoreOp[] = []
  const store = recordingStore(ops)
  const disk = virtualDisk(rows)
  const ledger = new SegmentHourLedger({
    store,
    logger: silentLogger(),
    listHour: disk.listHour,
  })
  await ledger.declare()
  for (const r of rows) await ledger.recordSegment(r)
  ops.length = 0
  return { ledger, ops, listed: disk.listed }
}

/**
 * Same archive, but read by a ledger that has only BOOTED over it.
 *
 * The seeding ledger listed nothing and has written every hour it recorded; a
 * listing-count assertion made against that one would be measuring the
 * seeding, not the read. This one arrives with the whole table mirrored (ten
 * scalars a row since D523) and has touched the array exactly zero times.
 */
async function seededCold(rows: readonly SegmentRow[]): Promise<SeededArchive> {
  const ops: StoreOp[] = []
  const store = recordingStore(ops)
  const disk = virtualDisk(rows)
  const writer = new SegmentHourLedger({ store, logger: silentLogger() })
  await writer.declare()
  for (const r of rows) await writer.recordSegment(r)
  const ledger = new SegmentHourLedger({
    store,
    logger: silentLogger(),
    listHour: disk.listHour,
  })
  await ledger.declare()
  await ledger.load()
  ops.length = 0
  return { ledger, ops, listed: disk.listed }
}

const archiveOps = (ops: readonly StoreOp[]): readonly StoreOp[] =>
  ops.filter((o) => o.input.collection === RECORDING_SEGMENT_HOURS_COLLECTION)

describe('SegmentHourLedger.accountingForLocations — an aggregation, not a scan', () => {
  it('asks for SUM/MIN/MAX in ONE aggregate and never reads a row', async () => {
    const { ledger, ops } = await seeded([
      row(HOUR0 + 1_000, 100, 'recordings:default'),
      row(HOUR0 + 11_000, 250, 'recordings:default'),
      row(HOUR0 + HOUR_MS + 1_000, 40, 'recordingsLow:default'),
    ])

    const acct = await ledger.accountingForLocations(
      new Set(['recordings:default', 'recordingsLow:default']),
    )

    // THE assertion. A scan would also produce 390/3 — so what is pinned is
    // that the ledger asked the database to do the arithmetic.
    const issued = archiveOps(ops)
    expect(issued.map((o) => o.op)).toEqual(['aggregate'])
    expect(issued[0]?.input.fields).toEqual([
      { as: 'bytes', field: 'bytes', op: 'sum' },
      { as: 'segments', field: 'segments', op: 'sum' },
      { as: 'oldestMs', field: 'minStartMs', op: 'min' },
      { as: 'newestMs', field: 'maxStartMs', op: 'max' },
    ])

    expect(acct).toEqual({
      bytes: 390,
      count: 3,
      oldestMs: HOUR0 + 1_000,
      newestMs: HOUR0 + HOUR_MS + 1_000,
    })
  })

  it('carries every alias of one physical root in a SINGLE statement', async () => {
    const { ledger, ops } = await seeded([
      row(HOUR0 + 1_000, 100, 'recordings:default'),
      row(HOUR0 + 2_000, 100, 'recordingsLow:default'),
    ])

    await ledger.accountingForLocations(new Set(['recordings:default', 'recordingsLow:default']))

    // One question about one disk. Asking per location and adding the answers
    // is how a pool becomes two pools.
    const issued = archiveOps(ops)
    expect(issued).toHaveLength(1)
    expect(issued[0]?.input.filter?.whereIn?.['locationId']).toEqual([
      'recordings:default',
      'recordingsLow:default',
    ])
  })

  it('an empty domain is `null` oldest/newest, never 0', async () => {
    const { ledger } = await seeded([])
    expect(await ledger.accountingForLocations(new Set(['recordings:default']))).toEqual({
      bytes: 0,
      count: 0,
      oldestMs: null,
      newestMs: null,
    })
  })
})

describe('SegmentHourLedger.oldestSegments — a bounded read, not a sorted archive', () => {
  it('asks oldest-first WITH A LIMIT, and stops once the target is covered', async () => {
    // 200 hours of footage. The target needs one of them.
    const rows: SegmentRow[] = []
    for (let h = 0; h < 200; h++) rows.push(row(HOUR0 + h * HOUR_MS, 1_000, 'recordings:default'))
    const { ledger, ops, listed } = await seeded(rows)

    const oldest = await ledger.oldestSegments(new Set(['recordings:default']), 500)

    const issued = archiveOps(ops)
    const probe = issued[0]
    expect(probe?.op).toBe('query')
    expect(probe?.input.filter?.orderBy).toEqual({ field: 'hourStartMs', direction: 'asc' })
    expect(probe?.input.filter?.limit).toBe(OLDEST_HOUR_PAGE)
    // The probe reads the accumulation's own three scalars and nothing else.
    expect(probe?.input.columns).toEqual(['hourStartMs', 'bytes', 'locationId'])
    // ONE page was enough, and it is the ONLY thing the read asked the store:
    // phase two is a directory listing now, not a second query (D523). A
    // second probe would mean the read is not bounded by the target.
    expect(issued.filter((o) => o.op === 'query')).toHaveLength(1)
    expect(listed).toHaveLength(1)
    // And it came back with a page's worth of hours, not the archive.
    expect(oldest.rows.length).toBeLessThanOrEqual(OLDEST_HOUR_PAGE)
    expect(oldest.rows[0]?.startMs).toBe(HOUR0)
    expect(oldest.exhausted).toBe(false)
  })

  it('two locations on ONE physical root come back as ONE oldest-first stream', async () => {
    // The correctness constraint. The oldest footage sits on the LOW alias and
    // the newest on the live one — a per-location query plus a merge, or a
    // stream partitioned by alias, deletes the wrong disk's newest footage.
    const { ledger, ops } = await seeded([
      row(HOUR0 + 0 * HOUR_MS, 100, 'recordingsLow:default'), // oldest
      row(HOUR0 + 1 * HOUR_MS, 100, 'recordingsLow:default'),
      row(HOUR0 + 2 * HOUR_MS, 100, 'recordings:default'),
      row(HOUR0 + 3 * HOUR_MS, 100, 'recordings:default'), // newest
    ])

    const oldest = await ledger.oldestSegments(
      new Set(['recordings:default', 'recordingsLow:default']),
      250,
    )

    // ONE probe statement, carrying BOTH ids.
    const probes = archiveOps(ops).filter((o) => o.input.filter?.orderBy !== undefined)
    expect(probes).toHaveLength(1)
    expect(probes[0]?.input.filter?.whereIn?.['locationId']).toEqual([
      'recordings:default',
      'recordingsLow:default',
    ])

    // And the stream is ordered across the aliases, not within each. Three
    // hours, not four: 250 is covered at the third (100+100+100), and phase one
    // stops choosing there. The alias property is what this pins, and it is
    // sharper at three — the two LOW hours are taken BEFORE the live alias's
    // first, which an alias-partitioned stream could not do.
    expect(oldest.rows.map((r) => r.locationId)).toEqual([
      'recordingsLow:default',
      'recordingsLow:default',
      'recordings:default',
    ])
    expect(oldest.rows.map((r) => r.startMs)).toEqual([
      HOUR0 + 0 * HOUR_MS,
      HOUR0 + 1 * HOUR_MS,
      HOUR0 + 2 * HOUR_MS,
    ])
  })

  it('says `exhausted` when the stream ends before the target is covered', async () => {
    const { ledger } = await seeded([row(HOUR0, 100, 'recordings:default')])
    const oldest = await ledger.oldestSegments(new Set(['recordings:default']), 999_999)
    expect(oldest.exhausted).toBe(true)
    expect(oldest.rows).toHaveLength(1)
  })

  it('a target of zero asks the database nothing at all', async () => {
    const { ledger, ops, listed } = await seeded([row(HOUR0, 100, 'recordings:default')])
    expect(await ledger.oldestSegments(new Set(['recordings:default']), 0)).toEqual({
      rows: [],
      exhausted: true,
    })
    expect(archiveOps(ops)).toEqual([])
    // Nor the array: a target of zero touches neither authority.
    expect(listed).toEqual([])
  })

  /**
   * A branch that drops work must not be silent (D391). An hour whose listing
   * comes back `null` — the directory could not be READ, which is a different
   * fact from "it holds nothing" — takes no part in the pass, and if that
   * happened quietly the caller's report would be indistinguishable from an
   * eviction that genuinely had nothing to delete.
   */
  it('an hour whose listing could not be read yields no rows and is SAID, per camera', async () => {
    const ops: StoreOp[] = []
    const store = recordingStore(ops)
    const lines: CapturedLine[] = []
    const undecided: HourLister = async () => null
    const ledger = new SegmentHourLedger({
      store,
      logger: capturingLogger(lines),
      listHour: undecided,
    })
    await ledger.declare()
    await ledger.recordSegment(row(HOUR0, 100, 'recordings:default'))
    lines.length = 0

    const oldest = await ledger.oldestSegments(new Set(['recordings:default']), 50)

    // No rows — and emphatically not an hour reported as holding nothing.
    expect(oldest.rows).toEqual([])
    const said = lines.find((l) => l.msg.includes('hour directory could not be listed'))
    expect(said?.level).toBe('warn')
    expect(said?.extras?.tags).toEqual({ deviceId: 99 })
    expect(said?.extras?.meta).toMatchObject({
      profile: 'high',
      locationId: 'recordings:default',
      hourStartMs: HOUR0,
      accounted: 1,
      reason: 'oldest-segments',
    })
  })
})

/**
 * ## What these pin, and why "before == after" alone would not have caught it
 *
 * Phase one's docblock always claimed it "walks oldest-first until the
 * accumulated bytes cover the target"; the record loop did not — it pushed
 * every hour of a full 32-hour page, so phase two took all 32 hours and built
 * ~6 240 `SegmentRow`s to delete the two segments the target was worth. Since
 * D523 the wasted work is 32 `readdir`s on the live array instead of 32 fat
 * blob fetches, which is cheaper per unit and exactly as unbounded.
 *
 * The victims must not move: strict oldest-first is the repo's deliberate
 * order. So each case asserts the selection against an ABSOLUTE oracle — the
 * globally oldest-first segments of the whole archive accumulating to the
 * target, computed without the ledger at all — and separately asserts the row
 * count actually built. An equivalence-only test would pass a break placed one
 * hour too early or too late as readily as a correct one, because both sides
 * would move together.
 */
const SEGMENTS_PER_HOUR = 6
const SEGMENT_BYTES = 1_000
const HOUR_BYTES = SEGMENTS_PER_HOUR * SEGMENT_BYTES
const SEGMENT_MS = 10_000

function archiveOfHours(hours: number, locationId = 'recordings:default'): SegmentRow[] {
  const out: SegmentRow[] = []
  for (let h = 0; h < hours; h++) {
    for (let i = 0; i < SEGMENTS_PER_HOUR; i++) {
      out.push(row(HOUR0 + h * HOUR_MS + i * SEGMENT_MS, SEGMENT_BYTES, locationId))
    }
  }
  return out
}

/** The victims strict oldest-first selection produces over the WHOLE archive —
 *  the answer the bounded read must reproduce, computed independently of it. */
function oracleVictimPaths(all: readonly SegmentRow[], targetBytes: number): readonly string[] {
  const oldestFirst = all.toSorted((a, b) => a.startMs - b.startMs)
  return selectEvictionsByBytes(oldestFirst, targetBytes).map((s) => s.path)
}

/** The hour directories phase two read — the hours phase one actually chose. */
function listedHours(listed: readonly HourListingCall[]): readonly number[] {
  return listed.map((call) => call.hourStartMs)
}

const probeCount = (ops: readonly StoreOp[]): number =>
  archiveOps(ops).filter((o) => o.input.filter?.orderBy !== undefined).length

describe('SegmentHourLedger.oldestSegments — phase one stops CHOOSING, not just paging', () => {
  it('one hour covers the target, so one hour is fetched and six rows are built', async () => {
    const all = archiveOfHours(200)
    const { ledger, ops, listed } = await seeded(all)

    const oldest = await ledger.oldestSegments(new Set(['recordings:default']), 2_500)

    // THE assertion: absolute, not relative. A full page would be 32 hours and
    // 192 rows — the shape that measured 6 240 rows on the live hub.
    expect(oldest.rows).toHaveLength(SEGMENTS_PER_HOUR)
    expect(listedHours(listed)).toEqual([HOUR0])
    expect(probeCount(ops)).toBe(1)
    expect(oldest.exhausted).toBe(false)

    // Same victims, same order, same bytes as strict oldest-first over the
    // whole archive.
    const victims = selectEvictionsByBytes(oldest.rows, 2_500)
    expect(victims.map((v) => v.path)).toEqual(oracleVictimPaths(all, 2_500))
    expect(victims).toHaveLength(3)
    expect(victims.reduce((sum, v) => sum + v.bytes, 0)).toBe(3_000)
    expect(victims.map((v) => v.startMs)).toEqual([
      HOUR0,
      HOUR0 + SEGMENT_MS,
      HOUR0 + 2 * SEGMENT_MS,
    ])
  })

  it('coverage landing EXACTLY on the target stops there — it does not take one more hour', async () => {
    const all = archiveOfHours(200)
    const target = 2 * HOUR_BYTES
    const { ledger, listed } = await seeded(all)

    const oldest = await ledger.oldestSegments(new Set(['recordings:default']), target)

    expect(listedHours(listed)).toEqual([HOUR0, HOUR0 + HOUR_MS])
    expect(oldest.rows).toHaveLength(2 * SEGMENTS_PER_HOUR)
    // The boundary is `covered >= targetBytes`: the hour that lands the target
    // exactly is IN, the next one is not.
    expect(oldest.rows.at(-1)?.startMs).toBe(HOUR0 + HOUR_MS + 5 * SEGMENT_MS)
    expect(oldest.exhausted).toBe(false)

    const victims = selectEvictionsByBytes(oldest.rows, target)
    expect(victims.map((v) => v.path)).toEqual(oracleVictimPaths(all, target))
    expect(victims).toHaveLength(2 * SEGMENTS_PER_HOUR)
    expect(victims.reduce((sum, v) => sum + v.bytes, 0)).toBe(target)
  })

  it('an archive that fits in the FIRST page is still only chosen up to the target', async () => {
    // Five hours — the probe returns a short page, so pre-change this reported
    // `exhausted` AND built all 30 rows. The stream did not run out: the target
    // was met, which is the one thing the flag denies.
    const all = archiveOfHours(5)
    const { ledger, listed } = await seeded(all)

    const oldest = await ledger.oldestSegments(new Set(['recordings:default']), 2_500)

    expect(oldest.rows).toHaveLength(SEGMENTS_PER_HOUR)
    expect(listedHours(listed)).toEqual([HOUR0])
    expect(oldest.exhausted).toBe(false)
    const victims = selectEvictionsByBytes(oldest.rows, 2_500)
    expect(victims.map((v) => v.path)).toEqual(oracleVictimPaths(all, 2_500))
  })

  it('a target spanning pages fetches the page that BREAKS and no page after it', async () => {
    const all = archiveOfHours(100)
    // 40 hours' worth, less one byte — the break lands inside page two.
    const target = 40 * HOUR_BYTES - 1
    const { ledger, ops, listed } = await seeded(all)

    const oldest = await ledger.oldestSegments(new Set(['recordings:default']), target)

    expect(probeCount(ops)).toBe(2)
    expect(listed).toHaveLength(40)
    expect(oldest.rows).toHaveLength(40 * SEGMENTS_PER_HOUR)
    expect(oldest.exhausted).toBe(false)

    const victims = selectEvictionsByBytes(oldest.rows, target)
    expect(victims.map((v) => v.path)).toEqual(oracleVictimPaths(all, target))
    expect(victims).toHaveLength(40 * SEGMENTS_PER_HOUR)
  })

  it('an under-covered target still pages, and still says `exhausted`', async () => {
    // The break can never set the flag, and it must not suppress it either.
    const all = archiveOfHours(40)
    const { ledger, ops } = await seeded(all)

    const oldest = await ledger.oldestSegments(new Set(['recordings:default']), 999_999_999)

    expect(probeCount(ops)).toBe(2)
    expect(oldest.rows).toHaveLength(40 * SEGMENTS_PER_HOUR)
    expect(oldest.exhausted).toBe(true)
    expect(selectEvictionsByBytes(oldest.rows, 999_999_999).map((v) => v.path)).toEqual(
      oracleVictimPaths(all, 999_999_999),
    )
  })

  /**
   * The 30 TB reason this case is ranked where it is. D523 removed the staging
   * it used to pin — there is no second tier to make a row paths-resident any
   * more — so what is pinned instead is the cost that actually bounds phase two
   * today: the number of hour DIRECTORIES the array is asked to read. One
   * eviction round must list a number of hours that is a function of the
   * TARGET, never of the archive, and never of the probe PAGE either.
   */
  it('lists only the hours it chose — the listing term stops scaling with the archive', async () => {
    const { ledger, listed } = await seededCold(archiveOfHours(200))
    // A boot touches the array not at all: the table alone answers how much.
    expect(listed).toHaveLength(0)
    expect(ledger.snapshot()).toHaveLength(200)

    await ledger.oldestSegments(new Set(['recordings:default']), 2_500)

    // One hour covers 2 500 bytes. Not 32 (the page), not 200 (the archive).
    expect(listedHours(listed)).toEqual([HOUR0])
    expect(ledger.snapshot()).toHaveLength(200)
  })
})
