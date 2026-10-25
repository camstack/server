/**
 * The two operator-triggered jobs that walk retrain frames by storage location
 * — the event-media discard and the media relocate / seal — on a RECORDS hub.
 *
 * There the legacy `pipeline-analytics:retrain-frames` table is undeclared (no
 * boot declares a table a records kind adopted from) and is dropped offline,
 * and the backend refuses a read of an undeclared collection. The store below
 * refuses it the same way, so a job that still names the legacy table fails
 * here exactly as it failed on `.50`; the frames live only in the
 * `retrain-frames` records kind, reached through the retrain-frame ledger.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SettingsStoreClient } from '@camstack/types'
import type { MediaBlobStorage } from '../location-aware-media-storage.js'
import { MediaRelocateEngine } from '../media-relocate-engine.js'
import { pipelineAnalyticsRecordKinds } from '../record-kinds.js'
import { createDiscardJob } from '../retention/location-discard-job.js'
import { RETRAIN_FRAMES_COLLECTION } from '../retrain/retrain-frame-store.js'
import { wireRetrainFrameLedger } from '../store/event-ledger-wiring.js'
import { MediaStore } from '../store/media-store.js'
import { makeFakeRecords } from './fake-records.js'
import { makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

const REFUSED = `collection "${RETRAIN_FRAMES_COLLECTION}" is not declared`

/** What a migrated hub's backend does to a legacy table: refuse every verb. */
function refuseLegacyRetrainFrames(client: SettingsStoreClient): void {
  const refuse = (collection: string): void => {
    if (collection === RETRAIN_FRAMES_COLLECTION) throw new Error(REFUSED)
  }
  const query = client.query.query.bind(client.query)
  vi.spyOn(client.query, 'query').mockImplementation(async (input) => {
    refuse(input.collection)
    return query(input)
  })
  const count = client.count.query.bind(client.count)
  vi.spyOn(client.count, 'query').mockImplementation(async (input) => {
    refuse(input.collection)
    return count(input)
  })
  const set = client.set.mutate.bind(client.set)
  vi.spyOn(client.set, 'mutate').mockImplementation(async (input) => {
    refuse(input.collection)
    return set(input)
  })
  const update = client.update.mutate.bind(client.update)
  vi.spyOn(client.update, 'mutate').mockImplementation(async (input) => {
    refuse(input.collection)
    return update(input)
  })
  const updateWhere = client.updateWhere.mutate.bind(client.updateWhere)
  vi.spyOn(client.updateWhere, 'mutate').mockImplementation(async (input) => {
    refuse(input.collection)
    return updateWhere(input)
  })
  const del = client.delete.mutate.bind(client.delete)
  vi.spyOn(client.delete, 'mutate').mockImplementation(async (input) => {
    refuse(input.collection)
    return del(input)
  })
  const deleteWhere = client.deleteWhere.mutate.bind(client.deleteWhere)
  vi.spyOn(client.deleteWhere, 'mutate').mockImplementation(async (input) => {
    refuse(input.collection)
    return deleteWhere(input)
  })
}

function frameRow(id: string, copiedAt: number, locationId: string | null) {
  return {
    id,
    deviceId: 101,
    at: copiedAt,
    data: {
      deviceId: 101,
      trackId: 'track-a',
      sourceMediaId: 1,
      sourceKind: 'keyFrame',
      path: `retrain/101/track-a/${id}.jpg`,
      sizeBytes: 3,
      width: 10,
      height: 10,
      copiedAt,
      locationId,
      revision: 0,
    },
  }
}

async function recordsHub() {
  const fake = makeFakeSettingsStore()
  await MediaStore.declare(fake.client)
  refuseLegacyRetrainFrames(fake.client)
  const records = makeFakeRecords()
  await records.records.declare(pipelineAnalyticsRecordKinds)
  const ledger = wireRetrainFrameLedger({ records: records.records })
  return { fake, records, ledger }
}

async function waitDone(engine: MediaRelocateEngine, jobId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const job = engine.list().find((candidate) => candidate.jobId === jobId)
    if (job && job.state !== 'running') return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('relocate did not finish')
}

describe('retrain-frame jobs on a records-only hub (legacy table refused)', () => {
  it('discard deletes the frames stamped with the discarded location from the records kind', async () => {
    const { fake, records, ledger } = await recordsHub()
    records.seed('retrain-frames', frameRow('on-hdd', 1, 'eventMedia:default'))
    records.seed('retrain-frames', frameRow('on-ssd', 2, 'eventMedia:ssd'))
    records.seed('retrain-frames', frameRow('durable', 3, 'retrainMedia'))
    const job = createDiscardJob({
      listLocations: async () => [
        {
          id: 'eventMedia:default',
          type: 'eventMedia',
          enabled: false,
          config: { basePath: '/nonexistent-discard-root' },
          nodeId: 'hub',
        },
        {
          id: 'eventMedia:ssd',
          type: 'eventMedia',
          enabled: true,
          config: { basePath: '/media-fast/eventMedia' },
          nodeId: 'hub',
        },
      ],
      localNodeId: 'hub',
      store: fake.client,
      retrainFrameLedger: ledger,
      deleteTrackEvents: async () => undefined,
      now: () => 1,
      paceMs: 0,
      wipe: async () => ({
        cancelled: false,
        camerasDone: 0,
        foldersRemoved: 0,
      }),
    })
    await job.start({ locationId: 'eventMedia:default' })
    await job.waitForIdle()
    const status = job.status()
    expect(status.error).toBeNull()
    expect(status.phase).toBe('complete')
    expect(status.dbRowsDeleted).toBe(1)
    expect([...(records.tables.get('retrain-frames')?.keys() ?? [])].toSorted()).toEqual([
      'durable',
      'on-ssd',
    ])
  })

  it('relocate counts, seals and moves retrain frames through the records kind', async () => {
    const { fake, records, ledger } = await recordsHub()
    records.seed('retrain-frames', frameRow('unstamped', 1, null))
    records.seed('retrain-frames', frameRow('on-old', 2, 'eventMedia:old'))
    records.seed('retrain-frames', frameRow('durable', 3, 'retrainMedia'))
    const blobs = new Map<string, Buffer>([
      ['eventMedia:old|retrain/101/track-a/on-old.jpg', Buffer.from('abc')],
    ])
    const storage: MediaBlobStorage = {
      write: async ({ location, relativePath, data }) => {
        blobs.set(`${location}|${relativePath}`, data)
      },
      read: async ({ location, relativePath }) => {
        const bytes = blobs.get(`${location}|${relativePath}`)
        if (bytes === undefined) throw new Error('missing blob')
        return bytes
      },
      delete: async ({ location, relativePath }) => {
        blobs.delete(`${location}|${relativePath}`)
      },
    }
    let n = 0
    const engine = new MediaRelocateEngine({
      store: fake.client,
      retrainFrameLedger: ledger,
      storage,
      logger: makeSilentLogger(),
      now: () => 1,
      newId: () => `job-${String(++n)}`,
      resolveTargetRoot: async (id) => `/roots/${id}`,
    })

    const census = await engine.countUnstamped()
    expect(census?.retrainFrames).toEqual({ present: true, rows: 1 })

    const seal = engine.start({ toLocationId: 'eventMedia:old', mode: 'seal' })
    await waitDone(engine, seal)
    expect(engine.list().find((j) => j.jobId === seal)?.state).toBe('done')
    const table = records.tables.get('retrain-frames')
    expect(table?.get('unstamped')?.data['locationId']).toBe('eventMedia:old')
    expect((await engine.countUnstamped())?.retrainFrames).toEqual({
      present: false,
      rows: 0,
    })

    // Moving `eventMedia:old` → `eventMedia:new`: the pre-D781 copies move,
    // the durable `retrainMedia` copy never does.
    blobs.set('eventMedia:old|retrain/101/track-a/unstamped.jpg', Buffer.from('xyz'))
    const selectable = await engine.countSelectable({
      toLocationId: 'eventMedia:new',
    })
    expect(selectable).toEqual({ rows: 2 })
    const move = engine.start({ toLocationId: 'eventMedia:new' })
    await waitDone(engine, move)
    const done = engine.list().find((j) => j.jobId === move)
    expect(done?.error ?? null).toBeNull()
    expect(done?.state).toBe('done')
    expect(done?.filesMoved).toBe(2)
    expect(table?.get('on-old')?.data['locationId']).toBe('eventMedia:new')
    expect(table?.get('unstamped')?.data['locationId']).toBe('eventMedia:new')
    expect(table?.get('durable')?.data['locationId']).toBe('retrainMedia')
    expect(blobs.has('eventMedia:new|retrain/101/track-a/on-old.jpg')).toBe(true)
    expect(blobs.has('eventMedia:old|retrain/101/track-a/on-old.jpg')).toBe(false)
  })
})
