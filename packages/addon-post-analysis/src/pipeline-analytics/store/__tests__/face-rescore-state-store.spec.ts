/**
 * The face rescore's memory over the `face-rescore-state` record kind: the
 * fingerprint it ran under and the report it produced, one row (id `last-run`).
 * Losing it costs one idempotent rerun; a state that does NOT land must be
 * visible to the caller, and an unreadable one must read as "never run".
 */
import { describe, expect, it } from 'vitest'
import type { FaceRescoreJobStatus } from '../../face-rescore-job-status.js'
import { makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { FaceRescoreStateStore, type FaceRescoreRunState } from '../face-rescore-state-store.js'

const report: FaceRescoreJobStatus = {
  jobId: 'job-7',
  state: 'completed',
  scanned: 120,
  total: 120,
  changed: 9,
  newlySuggested: 4,
  raised: 3,
  lowered: 1,
  cleared: 1,
  modelMismatch: 2,
  noVector: 5,
  batches: 3,
  maxBatchStoreMs: 41,
  durationMs: 1_234,
  galleryFingerprint: 'gal-abc',
  fingerprint: 'fp-xyz',
  startedAt: 1_700_000_000_000,
}
const state: FaceRescoreRunState = {
  fingerprint: 'fp-xyz',
  finishedAt: 1_700_000_001_234,
  report,
}

async function build() {
  const world = await makeAnalyticsRecords()
  const logs = makeLogRecorder()
  return {
    world,
    logs,
    store: FaceRescoreStateStore.of(world.records, logs.logger),
  }
}

describe('FaceRescoreStateStore over the records kind', () => {
  it('round-trips the whole run state through a fresh store — the respawn', async () => {
    const { world, store } = await build()
    await store.save(state)
    expect(world.tables.get('face-rescore-state')?.get('last-run')?.data).toEqual(state)
    const reborn = FaceRescoreStateStore.of(world.records, makeLogRecorder().logger)
    expect(await reborn.load()).toEqual(state)
  })

  it('reads as never-run when no row exists or the row does not parse', async () => {
    const { world, store } = await build()
    expect(await store.load()).toBeNull()
    world.seed('face-rescore-state', {
      id: '300329',
      data: { fingerprint: '', finishedAt: 1 },
    })
    expect(await store.load()).toBeNull()
  })

  it('answers never-run and says so when the read fails', async () => {
    const { world, store, logs } = await build()
    await store.save(state)
    world.failReads(true)
    expect(await store.load()).toBeNull()
    expect(logs.entries.some((e) => e.level === 'warn')).toBe(true)
  })

  it('a save that does not land THROWS', async () => {
    const { world, store } = await build()
    world.failWrites(true)
    await expect(store.save(state)).rejects.toThrow()
  })
})
