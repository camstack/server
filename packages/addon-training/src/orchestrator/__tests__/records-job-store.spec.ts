/**
 * RecordsJobStore over a fake kind handle — put / get / list / idempotency.
 */
import { describe, expect, it } from 'vitest'
import type { RecordKindHandle, RecordRow, TrainingJob } from '@camstack/types'
import { silentLogger } from '../../__tests__/harness.js'
import { RecordsJobStore } from '../stores.js'

function job(
  overrides: Partial<TrainingJob> & Pick<TrainingJob, 'id' | 'idempotencyKey'>,
): TrainingJob {
  return {
    id: overrides.id,
    idempotencyKey: overrides.idempotencyKey,
    name: overrides.name ?? 't',
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: overrides.updatedAt ?? 1000,
    state: overrides.state ?? 'queued',
    batchId: overrides.batchId ?? null,
    stage: overrides.stage ?? null,
    failure: overrides.failure ?? null,
    request: overrides.request ?? {
      selection: { collectionIds: ['c'], workState: 'complete' },
      entryId: 'e',
      gpuType: 'L4',
      region: '',
      baseModelId: 'yolov9m-640',
      preset: 'standard',
      freeze: null,
      holdoutCameras: null,
    },
    maxCostUsd: overrides.maxCostUsd ?? 1,
    maxRuntimeSec: overrides.maxRuntimeSec ?? 3600,
    trainer: overrides.trainer ?? { repo: 'camstack/camstack-trainer', revision: 'abcdef1' },
    datasetLayout: overrides.datasetLayout ?? 'frames',
    frameCount: overrides.frameCount ?? 0,
    frameIds: overrides.frameIds ?? [],
    annotationHash: overrides.annotationHash ?? 'h',
    dataset: overrides.dataset ?? null,
    split: overrides.split ?? {
      holdoutCameras: [],
      holdoutLastDays: 0,
      holdoutSupport: null,
      trainSubjects: 0,
    },
    provider: overrides.provider ?? {
      state: null,
      providerJobId: null,
      startedAt: null,
      endedAt: null,
      billedSeconds: 0,
      costUsd: 0,
      costIsEstimate: false,
      lastPolledAt: null,
    },
    progress: overrides.progress ?? { epoch: null, epochs: null, etaSec: null, series: [] },
    logTail: overrides.logTail ?? [],
    logCursor: overrides.logCursor ?? null,
    artifacts: overrides.artifacts ?? null,
    cloudDatasetDeletedAt: overrides.cloudDatasetDeletedAt ?? null,
    cloudCleanupDueAt: overrides.cloudCleanupDueAt ?? null,
    registeredModelIds: overrides.registeredModelIds ?? [],
    canary: overrides.canary ?? null,
  }
}

type FakeRow = RecordRow<TrainingJob | Record<string, unknown>>

function fakeKind(): {
  readonly handle: RecordKindHandle<TrainingJob>
  readonly rows: Map<string, FakeRow>
} {
  const rows = new Map<string, FakeRow>()
  const asJobRow = (row: FakeRow): RecordRow<TrainingJob> => ({
    id: row.id,
    deviceId: row.deviceId,
    at: row.at,
    expiresAt: row.expiresAt,
    rev: row.rev,
    updatedAt: row.updatedAt,
    data: row.data as TrainingJob,
  })
  const handle: RecordKindHandle<TrainingJob> = {
    name: 'jobs',
    get: async (id) => {
      const r = rows.get(id)
      return r === undefined ? null : asJobRow(r)
    },
    getMany: async (ids) =>
      ids.flatMap((id) => {
        const r = rows.get(id)
        return r === undefined ? [] : [asJobRow(r)]
      }),
    getResolved: async (id) => {
      const r = rows.get(id)
      return r === undefined ? null : asJobRow(r)
    },
    put: async (input) => {
      const prev = rows.get(input.id)
      const rev = (prev?.rev ?? 0) + 1
      rows.set(input.id, {
        id: input.id,
        deviceId: input.deviceId ?? null,
        at: input.at ?? null,
        expiresAt: input.expiresAt ?? null,
        rev,
        updatedAt: Date.now(),
        data: input.data,
      })
      return { rev }
    },
    putMany: async () => ({ count: 0 }),
    patch: async () => ({ rev: 1 }),
    delete: async (id) => rows.delete(id),
    deleteMany: async () => 0,
    query: async (q) => {
      let list = [...rows.values()].map(asJobRow)
      const where = q.where
      if (where !== undefined && typeof where['idempotencyKey'] === 'string') {
        const key = where['idempotencyKey']
        list = list.filter((r) => r.data.idempotencyKey === key)
      }
      if (q.order === 'at') {
        list = list.toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0))
        if (q.desc === true) list = list.toReversed()
      }
      return { records: list.slice(0, q.limit ?? 100), nextCursor: null }
    },
    count: async () => rows.size,
    histogram: async () => [],
    aggregate: async () => [],
    deleteWhere: async () => 0,
    allocateId: async () => 1,
    txPut: () => {
      throw new Error('not used')
    },
    txPatch: () => {
      throw new Error('not used')
    },
    txDelete: () => {
      throw new Error('not used')
    },
  }
  return { handle, rows }
}

describe('RecordsJobStore', () => {
  it('round-trips a job and finds it by idempotency key', async () => {
    const { handle } = fakeKind()
    const store = new RecordsJobStore(handle, silentLogger())
    const a = job({ id: 'j1', idempotencyKey: 'idem-a', createdAt: 2000, name: 'A' })
    const b = job({ id: 'j2', idempotencyKey: 'idem-b', createdAt: 1000, name: 'B' })
    await store.put(a)
    await store.put(b)
    expect(await store.get('j1')).toMatchObject({ id: 'j1', name: 'A' })
    expect(await store.findByIdempotencyKey('idem-b')).toMatchObject({ id: 'j2' })
    const listed = await store.list()
    expect(listed.map((j) => j.id)).toEqual(['j1', 'j2'])
  })

  it('skips a row that does not parse as a TrainingJob', async () => {
    const { handle, rows } = fakeKind()
    rows.set('bad', {
      id: 'bad',
      deviceId: null,
      at: 1,
      expiresAt: null,
      rev: 1,
      updatedAt: 1,
      data: { not: 'a job' },
    })
    const store = new RecordsJobStore(handle, silentLogger())
    expect(await store.get('bad')).toBeNull()
    expect(await store.list()).toEqual([])
  })
})
