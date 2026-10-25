/**
 * The debug-note ARCHIVE (D405) — the corpus that outlives the track.
 *
 * What is pinned here is the storage contract, because every later use of the
 * corpus reads it:
 *
 *  - a row survives its track: nothing in this table is track-owned, and the
 *    only writer is the hub clearing the note off a reviewed track;
 *  - archiving is IDEMPOTENT per `(sourceTrackId, note)` — an operator who
 *    reviews the same track twice must not double the corpus, and the row id
 *    is derived from the pair rather than minted fresh;
 *  - an EMPTY note archives nothing at all;
 *  - the table is BOUNDED by row count, oldest evicted first, so a stuck
 *    script cannot grow it without limit;
 *  - the read path answers newest-first, filtered per camera, capped.
 */
import {
  MAX_ARCHIVED_DEBUG_NOTES,
  type RecordKindHandle,
  type RecordsAccess,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { type FakeRecords, kindRows, makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeLogRecorder, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { DebugNoteArchiveStore } from '../debug-note-archive-store.js'
import { wireDebugNoteArchiveLedger } from '../event-ledger-wiring.js'

/** The archive's ledger over `world`. */
function archiveLedger(world: FakeRecords): ReturnType<typeof wireDebugNoteArchiveLedger> {
  return wireDebugNoteArchiveLedger({ records: world.records })
}

/** `records` whose kinds' `count` throws while `failing()` says so — every other call passes through. */
function countFaulted(
  base: Pick<RecordsAccess, 'kind' | 'transact'>,
  failing: () => boolean,
): Pick<RecordsAccess, 'kind' | 'transact'> {
  const wrap = <T>(h: RecordKindHandle<T>): RecordKindHandle<T> => ({
    name: h.name,
    get: (id) => h.get(id),
    getMany: (ids) => h.getMany(ids),
    getResolved: (id) => h.getResolved(id),
    put: (input, opts) => h.put(input, opts),
    putMany: (inputs) => h.putMany(inputs),
    patch: (id, partial, opts) => h.patch(id, partial, opts),
    delete: (id) => h.delete(id),
    deleteMany: (ids) => h.deleteMany(ids),
    query: (q, opts) => h.query(q, opts),
    count: async (q) => {
      if (failing()) throw new Error('sqlite is busy')
      return h.count(q)
    },
    histogram: (q) => h.histogram(q),
    aggregate: (q) => h.aggregate(q),
    deleteWhere: (q) => h.deleteWhere(q),
    allocateId: () => h.allocateId(),
    txPut: (input, opts) => h.txPut(input, opts),
    txPatch: (id, partial, opts) => h.txPatch(id, partial, opts),
    txDelete: (id) => h.txDelete(id),
  })
  return {
    kind: (definition) => wrap(base.kind(definition)),
    transact: (ops) => base.transact(ops),
  }
}

/** Rows the archive kind holds. */
function held(world: FakeRecords): number {
  return kindRows(world, 'debug-note-archive').length
}

describe('DebugNoteArchiveStore.append', () => {
  let fake: FakeRecords
  let archive: DebugNoteArchiveStore

  beforeEach(async () => {
    fake = await makeAnalyticsRecords()
    archive = new DebugNoteArchiveStore({
      archiveLedger: archiveLedger(fake),
      logger: makeSilentLogger(),
      now: () => 1_700_000_000_000,
    })
  })

  it('stores the note with the camera, the track and the context the row still knew', async () => {
    await archive.append({
      deviceId: 102,
      sourceTrackId: 'trk-1',
      note: 'the box jumps to the fence at 22:14',
      trackStartedAt: 1_699_999_000_000,
      trackClass: 'person',
      trackLabel: 'Alice',
    })

    const rows = await archive.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      deviceId: 102,
      sourceTrackId: 'trk-1',
      note: 'the box jumps to the fence at 22:14',
      archivedAt: 1_700_000_000_000,
      trackStartedAt: 1_699_999_000_000,
      trackClass: 'person',
      trackLabel: 'Alice',
    })
  })

  it('reports null — never a guessed value — for context the track row did not carry', async () => {
    await archive.append({ deviceId: 101, sourceTrackId: 'trk-2', note: 'check the crop' })

    const rows = await archive.list({})
    expect(rows[0]?.trackStartedAt).toBeNull()
    expect(rows[0]?.trackClass).toBeNull()
    expect(rows[0]?.trackLabel).toBeNull()
  })

  it('archives NOTHING for an empty note — reviewing a bare flag writes no row', async () => {
    const first = await archive.append({ deviceId: 101, sourceTrackId: 'trk-3', note: '' })
    const second = await archive.append({ deviceId: 101, sourceTrackId: 'trk-3', note: '   ' })

    expect(first.archived).toBe(false)
    expect(second.archived).toBe(false)
    expect(held(fake)).toBe(0)
  })

  it('is idempotent per (track, note): reviewing twice does not double the row', async () => {
    const first = await archive.append({
      deviceId: 101,
      sourceTrackId: 'trk-4',
      note: 'same words',
    })
    const again = await archive.append({
      deviceId: 101,
      sourceTrackId: 'trk-4',
      note: 'same words',
    })

    expect(first.archived).toBe(true)
    expect(again.archived).toBe(false)
    expect(held(fake)).toBe(1)
  })

  it('keeps a SECOND note on the same track — an edited question is a new one', async () => {
    await archive.append({ deviceId: 101, sourceTrackId: 'trk-5', note: 'first take' })
    await archive.append({ deviceId: 101, sourceTrackId: 'trk-5', note: 'second take' })

    expect(held(fake)).toBe(2)
  })

  it('keeps the same sentence written on a DIFFERENT track — the pair is the key', async () => {
    await archive.append({ deviceId: 101, sourceTrackId: 'trk-6', note: 'ghost box' })
    await archive.append({ deviceId: 101, sourceTrackId: 'trk-7', note: 'ghost box' })

    expect(held(fake)).toBe(2)
  })
})

describe('DebugNoteArchiveStore — the bound', () => {
  it('evicts the OLDEST rows once the ceiling is passed, and never the newest', async () => {
    const fake = await makeAnalyticsRecords()
    let clock = 1000
    const archive = new DebugNoteArchiveStore({
      archiveLedger: archiveLedger(fake),
      logger: makeSilentLogger(),
      now: () => clock,
      maxRows: 3,
    })

    for (const n of ['one', 'two', 'three', 'four', 'five']) {
      clock += 1000
      await archive.append({ deviceId: 101, sourceTrackId: `trk-${n}`, note: n })
    }

    const rows = await archive.list({})
    expect(rows.map((r) => r.note)).toEqual(['five', 'four', 'three'])
  })

  it('defaults its ceiling to the declared fleet bound — the test bound is a test bound', () => {
    expect(DebugNoteArchiveStore.defaultMaxRows()).toBe(MAX_ARCHIVED_DEBUG_NOTES)
  })

  it('a failed trim leaves the row that LANDED and says so — the note is not lost to housekeeping', async () => {
    const fake = await makeAnalyticsRecords()
    let countFails = false
    const recorder = makeLogRecorder()
    const archive = new DebugNoteArchiveStore({
      archiveLedger: wireDebugNoteArchiveLedger({
        records: countFaulted(fake.records, () => countFails),
      }),
      logger: recorder.logger,
      now: () => 5000,
      maxRows: 1,
    })
    await archive.append({ deviceId: 101, sourceTrackId: 'trk-a', note: 'kept' })

    countFails = true
    const out = await archive.append({ deviceId: 101, sourceTrackId: 'trk-b', note: 'also kept' })
    countFails = false

    expect(out.archived).toBe(true)
    expect(held(fake)).toBe(2)
    expect(recorder.entries.some((e) => e.level === 'warn')).toBe(true)
  })
})

describe('DebugNoteArchiveStore.list', () => {
  let fake: FakeRecords
  let archive: DebugNoteArchiveStore
  let clock: number

  beforeEach(async () => {
    fake = await makeAnalyticsRecords()
    clock = 1000
    archive = new DebugNoteArchiveStore({
      archiveLedger: archiveLedger(fake),
      logger: makeSilentLogger(),
      now: () => clock,
    })
    for (const [deviceId, note] of [
      [101, 'oldest'],
      [102, 'middle'],
      [101, 'newest'],
    ] as const) {
      clock += 1000
      await archive.append({ deviceId, sourceTrackId: `trk-${note}`, note })
    }
  })

  it('answers newest-first', async () => {
    const rows = await archive.list({})
    expect(rows.map((r) => r.note)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('filters to one camera', async () => {
    const rows = await archive.list({ deviceId: 101 })
    expect(rows.map((r) => r.note)).toEqual(['newest', 'oldest'])
  })

  it('caps at the requested limit', async () => {
    const rows = await archive.list({ limit: 1 })
    expect(rows.map((r) => r.note)).toEqual(['newest'])
  })
})
