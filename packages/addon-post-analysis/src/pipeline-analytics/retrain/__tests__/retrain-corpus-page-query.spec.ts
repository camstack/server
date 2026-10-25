/**
 * Corpus pages come from the clock index, not from loading every copy and
 * every annotation. The oracle is the in-memory filter/sort/slice the page
 * used to apply after that full load.
 */
import Database from 'better-sqlite3'
import { RecordsEngine } from '@camstack/system'
import {
  createRecordsAccess,
  type RecordsAccess,
  type RetrainCorpusFilter,
  type RetrainMacroClass,
  type RecordsTransport,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import type { EventLedgerCollection } from '../../store/event-ledger-collection.js'
import {
  wireRetrainAnnotationLedger,
  wireRetrainCollectionFrameLedger,
  wireRetrainCollectionLedger,
  wireRetrainFrameLedger,
} from '../../store/event-ledger-wiring.js'
import { RetrainAnnotationStore } from '../retrain-annotation-store.js'
import { RetrainCollectionStore } from '../retrain-collection-store.js'
import {
  filterCorpusRows,
  paginateCorpusRows,
  sortCorpusRowsNewestFirst,
  workStateOf,
  type CorpusFrameRow,
} from '../retrain-corpus-query.js'
import { RetrainFrameStore } from '../retrain-frame-store.js'
import { RetrainService } from '../retrain-service.js'

interface SeedFrame {
  readonly frameId: string
  readonly deviceId: number
  readonly copiedAt: number
  readonly complete: boolean
  readonly boxes: readonly RetrainMacroClass[]
  readonly collections: readonly string[]
}

/**
 * Inserted in this order so a shared `copiedAt` gets `rid` desc that is NOT
 * frameId asc (`e`, `f`, `aa` versus `aa`, `e`, `f`).
 */
const SEED: readonly SeedFrame[] = [
  { frameId: 'aa', deviceId: 101, copiedAt: 50, complete: false, boxes: [], collections: [] },
  {
    frameId: 'f',
    deviceId: 101,
    copiedAt: 50,
    complete: false,
    boxes: ['person'],
    collections: [],
  },
  {
    frameId: 'e',
    deviceId: 102,
    copiedAt: 50,
    complete: true,
    boxes: ['person', 'package', 'person'],
    collections: [],
  },
  { frameId: 'd', deviceId: 102, copiedAt: 40, complete: true, boxes: [], collections: ['col-2'] },
  {
    frameId: 'c',
    deviceId: 101,
    copiedAt: 30,
    complete: true,
    boxes: ['vehicle'],
    collections: ['col-1', 'col-2'],
  },
  {
    frameId: 'b',
    deviceId: 101,
    copiedAt: 20,
    complete: false,
    boxes: ['person', 'person'],
    collections: ['col-1'],
  },
  { frameId: 'a', deviceId: 101, copiedAt: 10, complete: false, boxes: [], collections: [] },
]

function oracleRows(): readonly CorpusFrameRow[] {
  return SEED.map((seed) => ({
    frameId: seed.frameId,
    deviceId: seed.deviceId,
    complete: seed.complete,
    annotationCount: seed.boxes.length,
    copiedAt: seed.copiedAt,
    collectionIds: [...seed.collections].toSorted(),
    classes: [...new Set(seed.boxes)].toSorted(),
  }))
}

interface Ledgers {
  readonly retrainFrames: EventLedgerCollection
  readonly retrainAnnotations: EventLedgerCollection
  readonly retrainCollections: EventLedgerCollection
  readonly retrainCollectionFrames: EventLedgerCollection
}

function watchListAll(frames: RetrainFrameStore) {
  return vi.spyOn(frames, 'listAll')
}

function watchListByFrames(annotations: RetrainAnnotationStore) {
  return vi.spyOn(annotations, 'listByFrames')
}

interface Harness {
  readonly service: RetrainService
  readonly collections: RetrainCollectionStore
  readonly listAll: ReturnType<typeof watchListAll>
  readonly listByFrames: ReturnType<typeof watchListByFrames>
}

function build(ledgers: Ledgers): Harness {
  const annotations = new RetrainAnnotationStore({
    annotationLedger: ledgers.retrainAnnotations,
    frameLedger: ledgers.retrainFrames,
    logger: makeSilentLogger(),
    now: () => 1,
    newId: () => 'unused',
  })
  const frames = new RetrainFrameStore({
    frameLedger: ledgers.retrainFrames,
    storage: {
      write: async () => undefined,
      read: async () => Buffer.alloc(0),
      delete: async () => undefined,
    },
    logger: makeSilentLogger(),
    now: () => 1,
    readSource: async () => null,
  })
  let collectionIds = 0
  const names = ['col-1', 'col-2']
  const collections = new RetrainCollectionStore({
    logger: makeSilentLogger(),
    now: () => 1,
    newId: () => names[collectionIds++] ?? 'col-x',
    collectionLedger: ledgers.retrainCollections,
    membershipLedger: ledgers.retrainCollectionFrames,
  })
  const service = new RetrainService({
    tracks: {
      listStaging: async () => [],
      listDeviceIds: async () => [],
      getPersistedByTrackId: async () => null,
      readStatus: async () => null,
      setStatus: async () => undefined,
    },
    media: { listTrackMedia: async () => [], readBlob: async () => null },
    frames,
    annotations,
    memberships: collections,
    runner: async () => {
      throw new Error('not used')
    },
    logger: makeSilentLogger(),
    frameUrl: (frameId, size) => `/${size}/${frameId}`,
  })
  return {
    service,
    collections,
    listAll: watchListAll(frames),
    listByFrames: watchListByFrames(annotations),
  }
}

async function seed(ledgers: Ledgers, collections: RetrainCollectionStore): Promise<void> {
  const porch = await collections.create({ name: 'Porch' })
  const gate = await collections.create({ name: 'Gate' })
  if (porch.kind !== 'created' || gate.kind !== 'created')
    throw new Error('collection seed refused')
  if (porch.collection.id !== 'col-1' || gate.collection.id !== 'col-2') {
    throw new Error('collection ids drifted from the oracle')
  }
  for (const frame of SEED) {
    await ledgers.retrainFrames.upsertRow(frame.frameId, {
      deviceId: frame.deviceId,
      trackId: 't',
      sourceMediaId: 1,
      sourceKind: 'keyFrame',
      sizeBytes: 10,
      width: 8,
      height: 8,
      copiedAt: frame.copiedAt,
      complete: frame.complete,
      revision: 0,
    })
    for (let i = 0; i < frame.boxes.length; i += 1) {
      const macroClass = frame.boxes[i]
      if (macroClass === undefined) continue
      await ledgers.retrainAnnotations.upsertRow(`${frame.frameId}:${String(i)}`, {
        trackId: 't',
        deviceId: frame.deviceId,
        mediaKey: frame.frameId,
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        macroClass,
        kind: 'subject',
        source: 'operator',
        createdAt: i + 1,
      })
    }
    for (const collectionId of frame.collections) {
      await collections.addFrame({ collectionId, frameId: frame.frameId, deviceId: frame.deviceId })
    }
  }
}

function assertAnnotationsAreThePage(
  calls: ReadonlyArray<readonly [readonly string[]]>,
  pageIds: readonly string[],
): void {
  const allowed = new Set(pageIds)
  expect(calls.length).toBeGreaterThan(0)
  for (const [ids] of calls) {
    for (const id of ids) expect(allowed.has(id)).toBe(true)
  }
}

const FILTERS: readonly RetrainCorpusFilter[] = [
  { page: 1, pageSize: 2 },
  { page: 2, pageSize: 2 },
  { page: 3, pageSize: 3 },
  { page: 1, pageSize: 50 },
  { page: 1, pageSize: 2, deviceIds: [101] },
  { page: 1, pageSize: 10, deviceIds: [101, 102] },
  { page: 1, pageSize: 10, workState: 'unannotated' },
  { page: 1, pageSize: 10, workState: 'annotated' },
  { page: 1, pageSize: 10, workState: 'complete' },
  { page: 2, pageSize: 1, workState: 'unannotated' },
  { page: 1, pageSize: 10, classes: ['person'] },
  { page: 1, pageSize: 10, classes: ['vehicle', 'package'] },
  { page: 1, pageSize: 10, collectionId: 'col-1' },
  { page: 1, pageSize: 10, collectionId: 'missing' },
  {
    page: 1,
    pageSize: 10,
    workState: 'annotated',
    deviceIds: [101],
    collectionId: 'col-1',
    classes: ['person'],
  },
  { page: 1, pageSize: 10, workState: 'unannotated', classes: ['person'] },
  { page: 1, pageSize: 10, deviceIds: [] },
  { page: 99, pageSize: 10 },
]

describe('listCorpusPage reads a page, not the corpus', () => {
  let harness: Harness
  let ledgers: Ledgers

  beforeEach(async () => {
    const world = await makeAnalyticsWorld()
    ledgers = world.ledgers
    harness = build(world.ledgers)
    await seed(ledgers, harness.collections)
    harness.listAll.mockClear()
    harness.listByFrames.mockClear()
  })

  it('matches the in-memory oracle for every filter, and lists annotations only for that page', async () => {
    const rows = oracleRows()
    for (const filter of FILTERS) {
      harness.listAll.mockClear()
      harness.listByFrames.mockClear()
      const expected = paginateCorpusRows(
        sortCorpusRowsNewestFirst(filterCorpusRows(rows, filter)),
        filter.page,
        filter.pageSize,
      )
      const page = await harness.service.listCorpusPage(filter)
      expect(harness.listAll).not.toHaveBeenCalled()
      expect(page.total).toBe(expected.total)
      expect(page.page).toBe(expected.page)
      expect(page.pageSize).toBe(expected.pageSize)
      expect(
        page.frames.map((frame) => ({
          frameId: frame.frameId,
          workState: frame.workState,
          thumbnailUrl: frame.thumbnailUrl,
          imageUrl: frame.imageUrl,
        })),
      ).toEqual(
        expected.rows.map((row) => ({
          frameId: row.frameId,
          workState: workStateOf(row, row.annotationCount),
          thumbnailUrl: `/thumb/${row.frameId}`,
          imageUrl: `/full/${row.frameId}`,
        })),
      )
      if (expected.rows.length > 0) {
        assertAnnotationsAreThePage(
          harness.listByFrames.mock.calls,
          expected.rows.map((row) => row.frameId),
        )
      } else {
        expect(harness.listByFrames).not.toHaveBeenCalled()
      }
    }
  })

  it('pages the whole corpus once each, ties broken by frameId', async () => {
    const expected = sortCorpusRowsNewestFirst(oracleRows()).map((row) => row.frameId)
    const seen: string[] = []
    for (let page = 1; page <= expected.length + 1; page += 1) {
      harness.listAll.mockClear()
      const result = await harness.service.listCorpusPage({ page, pageSize: 1 })
      expect(harness.listAll).not.toHaveBeenCalled()
      expect(result.total).toBe(expected.length)
      seen.push(...result.frames.map((frame) => frame.frameId))
      if (result.frames.length === 0) break
    }
    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(seen.length)
  })
})

const OWNER = 'pipeline-analytics'

function engineTransport(engine: RecordsEngine): RecordsTransport {
  const as = <I extends object>(input: I): I & { readonly owner: string } =>
    Object.assign({}, input, { owner: OWNER })
  return {
    declareKinds: (i) => engine.declareKinds(as(i)),
    get: (i) => engine.get(as(i)),
    getMany: (i) => engine.getMany(as(i)),
    secretRefs: (i) => engine.secretRefs(as(i)),
    put: (i) => engine.put(as(i)),
    putMany: (i) => engine.putMany(as(i)),
    patch: (i) => engine.patch(as(i)),
    delete: (i) => engine.delete(as(i)),
    deleteMany: (i) => engine.deleteMany(as(i)),
    query: (i) => engine.query(as(i)),
    count: (i) => engine.count(as(i)),
    histogram: (i) => engine.histogram(as(i)),
    aggregate: (i) => engine.aggregate(as(i)),
    deleteWhere: (i) => engine.deleteWhere(as(i)),
    transact: (i) => engine.transact(as(i)),
    deleteDevice: (i) => engine.deleteDevice(as(i)),
    allocateId: (i) => engine.allocateId(as(i)),
  }
}

function retrainLedgers(records: Pick<RecordsAccess, 'kind' | 'transact'>): Ledgers {
  return {
    retrainFrames: wireRetrainFrameLedger({ records }),
    retrainAnnotations: wireRetrainAnnotationLedger({ records }),
    retrainCollections: wireRetrainCollectionLedger({ records }),
    retrainCollectionFrames: wireRetrainCollectionFrameLedger({ records }),
  }
}

/**
 * Same readers as `records-explain.ts`. That file lives in `@camstack/system`,
 * outside this package's `rootDir`, so the page spec carries the two functions
 * it needs to judge the statements the store actually prepared.
 */
interface ExplainedStatement {
  readonly sql: string
  readonly params: readonly unknown[]
}

interface PlanRow {
  readonly detail: string
}

interface OpRow {
  readonly opcode: string
  readonly p1: number
  readonly p2: number
}

function planOf(database: Database.Database, statement: ExplainedStatement): readonly string[] {
  return database
    .prepare<unknown[], PlanRow>(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...statement.params)
    .map((row) => row.detail)
}

function tableColumnReads(database: Database.Database, statement: ExplainedStatement): number {
  const root = database
    .prepare<[], { rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE name = 'records'")
    .get()?.rootpage
  const program = database
    .prepare<unknown[], OpRow>(`EXPLAIN ${statement.sql}`)
    .all(...statement.params)
  const tableCursors = new Set(
    program.filter((op) => op.opcode === 'OpenRead' && op.p2 === root).map((op) => op.p1),
  )
  return program.filter((op) => op.opcode === 'Column' && tableCursors.has(op.p1)).length
}

describe('corpus page plans on the real records engine (D447)', () => {
  let db: Database.Database
  let prepared: string[]

  beforeEach(() => {
    prepared = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  async function world(): Promise<Harness> {
    db = new Database(':memory:')
    const engine = new RecordsEngine(db, { databaseId: 'events', logger: makeSilentLogger() })
    const records = createRecordsAccess({
      owner: OWNER,
      transport: engineTransport(engine),
      secrets: null,
    })
    await records.declare({
      'retrain-frames': pipelineAnalyticsRecordKinds['retrain-frames'],
      'retrain-annotations': pipelineAnalyticsRecordKinds['retrain-annotations'],
      'retrain-collections': pipelineAnalyticsRecordKinds['retrain-collections'],
      'retrain-collection-frames': pipelineAnalyticsRecordKinds['retrain-collection-frames'],
    })
    const ledgers = retrainLedgers(records)
    const harness = build(ledgers)
    await seed(ledgers, harness.collections)
    return harness
  }

  function capture(): void {
    prepared = []
    const original = Database.prototype.prepare
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      prepared.push(sql)
      return original.call(this, sql)
    })
  }

  it('counts through the clock index without reading table rows, and pages with a small LIMIT', async () => {
    const harness = await world()
    capture()
    const page = await harness.service.listCorpusPage({ page: 1, pageSize: 2 })
    expect(page.frames.map((frame) => frame.frameId)).toEqual(['aa', 'e'])

    const counts = prepared.filter((sql) => sql.includes('COUNT(*) AS n'))
    const countSql = counts[0]
    expect(countSql).toBeDefined()
    if (countSql === undefined) return
    expect(tableColumnReads(db, { sql: countSql, params: [] })).toBe(0)
    expect(planOf(db, { sql: countSql, params: [] }).join(' ')).toContain('records_kind_at')

    const selects = prepared.filter((sql) => sql.includes('ORDER BY at DESC'))
    expect(selects.length).toBeGreaterThan(0)
    const explained = selects.filter((sql) => !sql.includes('?'))
    expect(explained.length).toBeGreaterThan(0)
    for (const sql of selects) {
      expect(sql).toContain('records_kind_at')
      const limit = /LIMIT (\d+)/.exec(sql)?.[1]
      expect(Number(limit)).toBeLessThanOrEqual(8)
    }
    for (const sql of explained) {
      expect(planOf(db, { sql, params: [] }).join(' ')).toContain('records_kind_at')
    }
  })

  it('a class filter groups on class_media without reading annotation bodies', async () => {
    const harness = await world()
    capture()
    const page = await harness.service.listCorpusPage({
      page: 1,
      pageSize: 10,
      classes: ['person'],
    })
    expect(page.frames.map((frame) => frame.frameId).toSorted()).toEqual(['b', 'e', 'f'])
    const grouped = prepared.filter((sql) => sql.includes('class_media'))
    expect(grouped.length).toBeGreaterThan(0)
    for (const sql of grouped) {
      expect(tableColumnReads(db, { sql, params: ['person'] })).toBe(0)
      expect(planOf(db, { sql, params: ['person'] }).join(' ')).toContain('class_media')
    }
  })
})
