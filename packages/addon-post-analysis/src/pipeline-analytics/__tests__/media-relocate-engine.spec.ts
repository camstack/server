import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeLogRecorder,
} from '../__tests__/test-helpers.js'
import {
  type FakeRecords,
  type InstrumentedRecords,
  instrumentRecords,
  kindRows,
  makeAnalyticsRecords,
  seedLedgerRows,
} from '../__tests__/fake-records.js'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'
import type { MediaBlobStorage } from '../location-aware-media-storage.js'
import { MediaRelocateEngine } from '../media-relocate-engine.js'
import { RetrainFrameStore } from '../retrain/retrain-frame-store.js'
import { MEDIA_COLLECTION, MediaStore } from '../store/media-store.js'
import { wireRetrainFrameLedger } from '../store/event-ledger-wiring.js'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
  withTags: () => logger,
} as unknown as IScopedLogger

/** A fixture's retrain-frames kind: the records world it lives in, counted. */
interface FrameWorld {
  readonly world: FakeRecords
  readonly records: InstrumentedRecords
  readonly ledger: EventLedgerCollection
}

/** Each fixture's frame world, by the settings store that holds its media rows. */
const frameWorlds = new WeakMap<FakeSettingsStore, FrameWorld>()

/** A fresh settings store (media) with its records world (retrain frames). */
async function makeFixture(): Promise<FakeSettingsStore> {
  const fake = makeFakeSettingsStore()
  const world = await makeAnalyticsRecords()
  const records = instrumentRecords(world.records)
  frameWorlds.set(fake, {
    world,
    records,
    ledger: wireRetrainFrameLedger({ records: records.records }),
  })
  return fake
}

function frameWorldOf(fake: FakeSettingsStore): FrameWorld {
  const fw = frameWorlds.get(fake)
  if (fw === undefined) throw new Error('fixture built without makeFixture')
  return fw
}

async function waitDone(engine: MediaRelocateEngine, jobId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const job = engine.list().find((candidate) => candidate.jobId === jobId)
    if (job && job.state !== 'running') return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('media move did not finish')
}

describe('MediaRelocateEngine retraining corpus', () => {
  it('keeps ad-hoc and coordinated callers on one single-flight engine', async () => {
    const fake = await makeFixture()
    const storage: MediaBlobStorage = {
      write: async () => undefined,
      read: async () => Buffer.alloc(0),
      delete: async () => undefined,
    }
    const engine = new MediaRelocateEngine({
      store: fake.client,
      retrainFrameLedger: frameWorldOf(fake).ledger,
      storage,
      logger,
      now: () => 1,
      newId: () => 'move-1',
      resolveTargetRoot: async () => '/target',
    })

    engine.start({ toLocationId: 'eventMedia:new' })
    expect(() => engine.start({ toLocationId: 'eventMedia:other' })).toThrow(/already running/)
  })

  it('moves retraining blobs, stamps their rows, and keeps the copy readable', async () => {
    const fake = await makeFixture()
    const path = 'retrain/101/track-a/copy.jpg'
    await seedLedgerRows(frameWorldOf(fake).ledger, [
      {
        id: 'retrain:track-a:copy',
        data: {
          deviceId: 101,
          trackId: 'track-a',
          sourceMediaKey: 'track:track-a:keyFrame',
          sourceKind: 'keyFrame',
          path,
          sizeBytes: 3,
          width: 1,
          height: 1,
          copiedAt: 1,
          locationId: null,
        },
      },
    ])
    const blobs = new Map<string, Buffer>([['eventMedia:' + path, Buffer.from('jpg')]])
    const storage: MediaBlobStorage = {
      write: async ({ location, relativePath, data }) => {
        blobs.set(`${location}:${relativePath}`, data)
      },
      read: async ({ location, relativePath }) => {
        const blob = blobs.get(`${location}:${relativePath}`)
        if (!blob) throw new Error('missing blob')
        return blob
      },
      delete: async ({ location, relativePath }) => {
        blobs.delete(`${location}:${relativePath}`)
      },
    }
    const engine = new MediaRelocateEngine({
      store: fake.client,
      retrainFrameLedger: frameWorldOf(fake).ledger,
      storage,
      logger,
      now: () => 1,
      newId: () => 'move-1',
      resolveTargetRoot: async () => '/target',
      sleep: async () => {},
    })

    const jobId = engine.start({ toLocationId: 'eventMedia:new' })
    await waitDone(engine, jobId)
    expect(engine.list()[0]?.state).toBe('done')
    expect(blobs.has(`eventMedia:${path}`)).toBe(false)
    expect(blobs.get(`eventMedia:new:${path}`)?.toString()).toBe('jpg')

    const store = new RetrainFrameStore({
      storage,
      frameLedger: frameWorldOf(fake).ledger,
      logger,
      now: () => 1,
      readSource: async () => null,
    })
    const frame = await store.get('retrain:track-a:copy')
    expect(frame).not.toBeNull()
    if (!frame) return
    expect(frame.locationId).toBe('eventMedia:new')
    expect((await store.readFrame(frame))?.toString()).toBe('jpg')
  })

  it('exhausts more than one page of rows sharing one timestamp', async () => {
    const fake = await makeFixture()
    await MediaStore.declare(fake.client)
    const blobs = new Map<string, Buffer>()
    fake.seed(
      MEDIA_COLLECTION,
      Array.from({ length: 201 }, (_, index) => {
        const path = `101/events/track/t/snapshot-${index}.jpg`
        blobs.set(`eventMedia:${path}`, Buffer.from('x'))
        return {
          id: `media-${String(index).padStart(3, '0')}`,
          data: {
            deviceId: 101,
            ownerKind: 'track',
            ownerId: 't',
            kind: 'snapshot',
            timestamp: 42,
            path,
            sizeBytes: 1,
            locationId: null,
          },
        }
      }),
    )
    const storage: MediaBlobStorage = {
      write: async ({ location, relativePath, data }) => {
        blobs.set(`${location}:${relativePath}`, data)
      },
      read: async ({ location, relativePath }) => {
        const blob = blobs.get(`${location}:${relativePath}`)
        if (!blob) throw new Error('missing blob')
        return blob
      },
      delete: async ({ location, relativePath }) => {
        blobs.delete(`${location}:${relativePath}`)
      },
    }
    const engine = new MediaRelocateEngine({
      store: fake.client,
      retrainFrameLedger: frameWorldOf(fake).ledger,
      storage,
      logger,
      now: () => 1,
      newId: () => 'move-ties',
      resolveTargetRoot: async () => '/target',
      sleep: async () => {},
    })
    const jobId = engine.start({ toLocationId: 'eventMedia:new' })
    await waitDone(engine, jobId)
    expect(engine.list()[0]?.filesMoved).toBe(201)
    expect(blobs.size).toBe(201)
    expect([...blobs.keys()].every((key) => key.startsWith('eventMedia:new:'))).toBe(true)
  })
})

/**
 * A row with `locationId: NULL` means "wherever `eventMedia` points NOW". Every
 * assertion here is about the moment a repoint moves that pointer.
 */
describe('MediaRelocateEngine seal', () => {
  /** Storage that FAILS every call — a seal that touches a blob fails loudly
   *  instead of passing because the fake was forgiving. */
  const noStorage: MediaBlobStorage = {
    write: async () => {
      throw new Error('seal must not write a blob')
    },
    read: async () => {
      throw new Error('seal must not read a blob')
    },
    delete: async () => {
      throw new Error('seal must not delete a blob')
    },
  }

  async function seedMixed(): Promise<ReturnType<typeof makeFakeSettingsStore>> {
    const fake = await makeFixture()
    await MediaStore.declare(fake.client)
    fake.seed(MEDIA_COLLECTION, [
      {
        id: 'media-null',
        data: {
          deviceId: 101,
          ownerKind: 'track',
          ownerId: 't1',
          kind: 'snapshot',
          timestamp: 10,
          path: '101/events/track/t1/snapshot-10.jpg',
          sizeBytes: 1,
          locationId: null,
        },
      },
      {
        id: 'media-stamped',
        data: {
          deviceId: 102,
          ownerKind: 'track',
          ownerId: 't2',
          kind: 'snapshot',
          timestamp: 20,
          path: '102/events/track/t2/snapshot-20.jpg',
          sizeBytes: 1,
          // Deliberately NOT the id the seals below stamp with. A fixture that
          // already carried the seal target could not tell "left alone" from
          // "re-stamped with the same value" — which is exactly how the first
          // version of this test passed with the row predicate disarmed.
          locationId: 'eventMedia:ssd',
        },
      },
    ])
    await seedLedgerRows(frameWorldOf(fake).ledger, [
      {
        id: 'retrain:track-a:copy',
        data: {
          deviceId: 101,
          trackId: 'track-a',
          sourceMediaKey: 'track:track-a:keyFrame',
          sourceKind: 'keyFrame',
          path: 'retrain/101/track-a/copy.jpg',
          sizeBytes: 3,
          width: 1,
          height: 1,
          copiedAt: 5,
          locationId: null,
        },
      },
    ])
    return fake
  }

  function buildEngine(fake: ReturnType<typeof makeFakeSettingsStore>): MediaRelocateEngine {
    return new MediaRelocateEngine({
      store: fake.client,
      retrainFrameLedger: frameWorldOf(fake).ledger,
      storage: noStorage,
      logger,
      now: () => 1,
      newId: () => 'seal-1',
      resolveTargetRoot: async () => '/target',
      sleep: async () => {},
    })
  }

  /**
   * The count is what the migration gate reads, and the fixture is mixed on
   * purpose: 2 of 3 rows unstamped, spread over both collections. A fixture
   * where every row is unstamped passes against a query that ignores the
   * predicate entirely — which is the exact bug this replaced (`= NULL`, which
   * matches nothing, and `countUnstamped` walking the whole collection to
   * avoid it).
   */
  it('counts exactly the rows that carry no locationId, across both collections', async () => {
    const engine = buildEngine(await seedMixed())
    expect(await engine.countUnstamped()).toEqual({
      media: { present: true, rows: 1 },
      retrainFrames: { present: true, rows: 1 },
      anyPresent: true,
      total: 2,
    })
  })

  /**
   * The defect that blocked 152 GB, expressed as a budget.
   *
   * The old implementation paged both collections at 200 rows per RPC — ~6 300
   * round trips on the live hub, ordered by an unindexed column, 60 s deadline
   * every time. The answer was RIGHT; the shape was unusable, and no assertion
   * about the returned number can see that. So this one counts round trips:
   * two per collection, whatever the collection holds.
   */
  it('asks the store a bounded question instead of walking the collection', async () => {
    const fake = await seedMixed()
    // Well past one page of the retired walk (PAGE_SIZE = 200), so a pass that
    // still paged would need three calls for this collection alone.
    for (let i = 0; i < 500; i++) {
      fake.seed(MEDIA_COLLECTION, [
        {
          id: `media-bulk-${i.toString()}`,
          data: {
            deviceId: 101,
            ownerKind: 'object',
            ownerId: `e${i.toString()}`,
            kind: 'snapshot',
            timestamp: 1000 + i,
            path: `101/events/object/e${i.toString()}/snapshot.jpg`,
            sizeBytes: 1,
            locationId: i % 2 === 0 ? null : 'eventMedia:ssd',
          },
        },
      ])
    }
    const engine = buildEngine(fake)
    const frames = frameWorldOf(fake).records
    const before = {
      query: fake.calls.query + frames.calls('query'),
      count: fake.calls.count + frames.calls('count'),
    }
    const counted = await engine.countUnstamped()
    // 250 of the 500 bulk rows are unstamped, plus the fixture's `media-null`.
    expect(counted?.media).toEqual({ present: true, rows: 251 })
    expect(counted?.total).toBe(252)
    // Media: one existence probe + one count. Retrain frames: ONE ledger read
    // of the (operator-selected, small) dataset — the records kind cannot
    // express `IS NULL`, so that lane is judged in memory, never walked in pages.
    expect(fake.calls.query + frames.calls('query') - before.query).toBe(2)
    expect(fake.calls.count + frames.calls('count') - before.count).toBe(1)
  })

  it('proves absence with a probe and never counts what it does not have to', async () => {
    const fake = await seedMixed()
    const engine = buildEngine(fake)
    await waitDone(engine, engine.start({ toLocationId: 'eventMedia:hdd', mode: 'seal' }))
    const frames = frameWorldOf(fake).records
    const before = {
      query: fake.calls.query + frames.calls('query'),
      count: fake.calls.count + frames.calls('count'),
    }
    expect(await engine.countUnstamped()).toEqual({
      media: { present: false, rows: 0 },
      retrainFrames: { present: false, rows: 0 },
      anyPresent: false,
      total: 0,
    })
    // The probe answers "none" on its own; the count is never asked. This is
    // the state the gate spends its life in, and it costs two seeks.
    expect(fake.calls.query + frames.calls('query') - before.query).toBe(2)
    expect(fake.calls.count + frames.calls('count') - before.count).toBe(0)
  })

  it('stamps every NULL row and moves no bytes at all', async () => {
    const fake = await seedMixed()
    const engine = buildEngine(fake)
    const jobId = engine.start({ toLocationId: 'eventMedia:hdd', mode: 'seal' })
    await waitDone(engine, jobId)
    // `noStorage` throws on any blob call, so reaching `done` IS the assertion
    // that this pass is row-only.
    expect(engine.list()[0]?.state).toBe('done')
    expect(await engine.countUnstamped()).toEqual({
      media: { present: false, rows: 0 },
      retrainFrames: { present: false, rows: 0 },
      anyPresent: false,
      total: 0,
    })
  })

  it('leaves an ALREADY-stamped row on its own location', async () => {
    const fake = await seedMixed()
    const engine = buildEngine(fake)
    await waitDone(engine, engine.start({ toLocationId: 'eventMedia:hdd', mode: 'seal' }))
    const rows = await fake.client.query.query({ collection: MEDIA_COLLECTION, filter: {} })
    const stamped = rows.find((row) => row.id === 'media-stamped')
    // A seal that re-homed a row already naming a DIFFERENT location would move
    // the pointer off the disk holding its bytes — the exact bug it prevents.
    expect(stamped?.data['locationId']).toBe('eventMedia:ssd')
  })

  it('a seal stamps the SOURCE, so a later repoint cannot re-aim those rows', async () => {
    const fake = await seedMixed()
    const engine = buildEngine(fake)
    await waitDone(engine, engine.start({ toLocationId: 'eventMedia:hdd', mode: 'seal' }))
    const media = await fake.client.query.query({ collection: MEDIA_COLLECTION, filter: {} })
    const retrain = kindRows(frameWorldOf(fake).world, 'retrain-frames')
    expect(media.find((row) => row.id === 'media-null')?.data['locationId']).toBe('eventMedia:hdd')
    expect(retrain[0]?.data['locationId']).toBe('eventMedia:hdd')
  })

  /**
   * The media lane's **M**.
   *
   * The footage lane has had one since D295 made `filesTotal` the ledger
   * census; this lane hard-coded `null`, so a media drain reported a count
   * against nothing. The count and the pass share one predicate on purpose —
   * two predicates is how a denominator ends up counting a different
   * population than the numerator.
   */
  it('counts exactly what the pass would act on, per mode', async () => {
    const engine = buildEngine(await seedMixed())
    // `move` selects both NULL rows plus the one stamped elsewhere; three rows.
    expect(await engine.countSelectable({ toLocationId: 'eventMedia:hdd' })).toEqual({ rows: 3 })
    // A row already AT the target is not work.
    expect(await engine.countSelectable({ toLocationId: 'eventMedia:ssd' })).toEqual({ rows: 2 })
    expect(
      await engine.countSelectable({
        toLocationId: 'eventMedia:hdd',
        fromLocationId: 'eventMedia:ssd',
      }),
    ).toEqual({ rows: 1 })
    // `seal` selects exactly the unstamped population, and agrees with the
    // independent counter the migration gate reads.
    expect(await engine.countSelectable({ toLocationId: 'eventMedia:hdd', mode: 'seal' })).toEqual({
      rows: 2,
    })
    expect((await engine.countUnstamped())?.total).toBe(2)
  })

  it('reports the denominator on the job, and it is reached', async () => {
    const fake = await seedMixed()
    const engine = buildEngine(fake)
    await waitDone(engine, engine.start({ toLocationId: 'eventMedia:hdd', mode: 'seal' }))
    const job = engine.list()[0]
    expect(job?.filesTotal).toBe(2)
    expect(job?.filesMoved).toBe(2)
  })
})

/**
 * `null` means "not measurable" and must never soften into `0`.
 *
 * The gate this feeds opens on an absence. Every read here can fail — the hub
 * it runs on is serving live traffic on a saturated disk, which is why the
 * previous shape timed out — so what it says when it CANNOT answer is not a
 * corner case, it is the case.
 */
describe('MediaRelocateEngine seal gate — honesty under a failing read', () => {
  const noStorage: MediaBlobStorage = {
    write: async () => {
      throw new Error('the seal gate must not touch a blob')
    },
    read: async () => {
      throw new Error('the seal gate must not touch a blob')
    },
    delete: async () => {
      throw new Error('the seal gate must not touch a blob')
    },
  }

  async function seedOneUnstamped(): Promise<ReturnType<typeof makeFakeSettingsStore>> {
    const fake = await makeFixture()
    await MediaStore.declare(fake.client)
    fake.seed(MEDIA_COLLECTION, [
      {
        id: 'media-null',
        data: {
          deviceId: 101,
          ownerKind: 'track',
          ownerId: 't1',
          kind: 'snapshot',
          timestamp: 10,
          path: '101/events/track/t1/snapshot-10.jpg',
          sizeBytes: 1,
          locationId: null,
        },
      },
      {
        id: 'media-stamped',
        data: {
          deviceId: 102,
          ownerKind: 'track',
          ownerId: 't2',
          kind: 'snapshot',
          timestamp: 20,
          path: '102/events/track/t2/snapshot-20.jpg',
          sizeBytes: 1,
          locationId: 'eventMedia:ssd',
        },
      },
    ])
    return fake
  }

  function buildEngine(
    fake: ReturnType<typeof makeFakeSettingsStore>,
    log: IScopedLogger,
  ): MediaRelocateEngine {
    return new MediaRelocateEngine({
      store: fake.client,
      retrainFrameLedger: frameWorldOf(fake).ledger,
      storage: noStorage,
      logger: log,
      now: () => 1,
      newId: () => 'seal-1',
      resolveTargetRoot: async () => '/target',
      sleep: async () => {},
    })
  }

  /**
   * The oldest unstamped rows do not carry `locationId: null` — they carry no
   * such key at all, because they were written before the column existed. In
   * SQLite an unwritten column IS NULL and `IS NULL` finds them; a fake that
   * compares against a JS `undefined` does not, and would report the one
   * population the seal exists for as already sealed.
   */
  it('finds rows that OMIT locationId, not only rows that set it to null', async () => {
    const fake = await makeFixture()
    await MediaStore.declare(fake.client)
    fake.seed(MEDIA_COLLECTION, [
      {
        id: 'media-pre-column',
        data: {
          deviceId: 101,
          ownerKind: 'track',
          ownerId: 't0',
          kind: 'keyFrame',
          timestamp: 5,
          path: '101/events/track/t0/keyFrame.jpg',
          sizeBytes: 1,
          // No `locationId` key whatsoever — the pre-Phase-3 row shape.
        },
      },
      {
        id: 'media-stamped',
        data: {
          deviceId: 102,
          ownerKind: 'track',
          ownerId: 't2',
          kind: 'snapshot',
          timestamp: 20,
          path: '102/events/track/t2/snapshot-20.jpg',
          sizeBytes: 1,
          locationId: 'eventMedia:ssd',
        },
      },
    ])
    const engine = buildEngine(fake, makeLogRecorder().logger)
    const counted = await engine.countUnstamped()
    expect(counted?.media).toEqual({ present: true, rows: 1 })
    expect(counted?.anyPresent).toBe(true)
  })

  it('reports the whole answer as unknown when the existence probe fails', async () => {
    const fake = await seedOneUnstamped()
    const recorder = makeLogRecorder()
    const engine = buildEngine(fake, recorder.logger)
    fake.faults.query = 'SQLITE_BUSY: database is locked'
    expect(await engine.countUnstamped()).toBeNull()
    // A branch that drops work says so. Silence here would read to the next
    // reader of the ops log as "the gate was checked and it was clean".
    expect(
      recorder.entries.some((e) => e.level === 'warn' && e.message.includes('unstamped')),
    ).toBe(true)
  })

  it('keeps the fact it HAS when only the count fails — present, size unknown', async () => {
    const fake = await seedOneUnstamped()
    const recorder = makeLogRecorder()
    const engine = buildEngine(fake, recorder.logger)
    fake.faults.count = 'interrupted: query deadline exceeded'
    const counted = await engine.countUnstamped()
    // The load-bearing half survived: this still refuses a cutover.
    expect(counted?.media).toEqual({ present: true, rows: null })
    expect(counted?.anyPresent).toBe(true)
    // And the total is unknown rather than a plausible partial sum.
    expect(counted?.total).toBeNull()
    expect(
      recorder.entries.some(
        (e) => e.level === 'warn' && e.message.includes('could not be counted'),
      ),
    ).toBe(true)
  })

  it('does not report zero for a collection it could not read', async () => {
    const fake = await seedOneUnstamped()
    const engine = buildEngine(fake, makeLogRecorder().logger)
    fake.faults.query = 'SQLITE_BUSY: database is locked'
    const counted = await engine.countUnstamped()
    // The assertion that matters: nothing in the answer can be mistaken for
    // "sealed". `null` has no `.total`, so a caller cannot read `0` off it.
    expect(counted).not.toEqual(expect.objectContaining({ anyPresent: false }))
    expect(counted).toBeNull()
  })
})
