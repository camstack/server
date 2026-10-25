/**
 * Boot reconcile for exports a restart interrupted.
 *
 * `ExportEngine`'s queue is in-memory, so a restart forgets every job it had
 * not started — while the DURABLE row keeps saying `queued` or `rendering`.
 * Nothing re-queued them, and nothing said so: a consumer polling such a row
 * waits out its whole bound and then reports a timeout for a render that was
 * never going to start.
 *
 * Live proof (2026-08-14): exports `76151053-…` (05:11) and `e1a4a3c2-…`
 * (05:17) for camera 1441 were still `queued` an hour after the 05:31 restart,
 * with no ffmpeg behind either.
 */
import type { ExportRecord } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { getExportRecord, type RecordingExportsState, upsertExport } from '../export-store.js'
import { makeExportsState } from './exports-state-fixture.js'
import { reconcileInterruptedExports } from '../export-reconcile.js'

const NOW = 1_000_000

function makeRecord(over: Partial<ExportRecord>): ExportRecord {
  return {
    id: 'e1',
    deviceId: 1441,
    profile: 'low',
    fromMs: 1000,
    toMs: 2000,
    options: {
      includeAudio: false,
      maxLifeMs: 604_800_000,
      deleteAfterDownload: false,
    },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: NOW + 3600_000,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: NOW - 3600_000,
    createdBy: 'operator',
    error: null,
    ...over,
  }
}

async function harness(): Promise<{
  readonly state: RecordingExportsState
  readonly enqueued: string[]
  readonly warns: string[]
  run: () => Promise<{ readonly requeued: number; readonly expired: number }>
}> {
  const state = await makeExportsState()
  const enqueued: string[] = []
  const warns: string[] = []
  return {
    state,
    enqueued,
    warns,
    run: () =>
      reconcileInterruptedExports({
        state,
        engine: { enqueue: (id) => enqueued.push(id) },
        now: () => NOW,
        logger: {
          info: () => undefined,
          debug: () => undefined,
          warn: (message: string) => warns.push(message),
        },
      }),
  }
}

describe('reconcileInterruptedExports', () => {
  it('re-queues a row a restart left QUEUED', async () => {
    const h = await harness()
    await upsertExport(h.state, makeRecord({ id: 'orphan', state: 'queued' }))
    const report = await h.run()
    expect(h.enqueued).toEqual(['orphan'])
    expect(report.requeued).toBe(1)
  })

  it('resets a row left RENDERING back to queued — its ffmpeg died with the process', async () => {
    const h = await harness()
    await upsertExport(
      h.state,
      makeRecord({
        id: 'half',
        state: 'rendering',
        progressPct: 47,
        error: 'stale',
      }),
    )
    await h.run()
    const row = await getExportRecord(h.state, 'half')
    expect(row?.state).toBe('queued')
    expect(row?.progressPct).toBeNull()
    expect(row?.error).toBeNull()
    expect(h.enqueued).toEqual(['half'])
  })

  it('leaves terminal rows alone', async () => {
    const h = await harness()
    await upsertExport(h.state, makeRecord({ id: 'a', state: 'ready', fileBytes: 10 }))
    await upsertExport(h.state, makeRecord({ id: 'b', state: 'failed' }))
    await upsertExport(h.state, makeRecord({ id: 'c', state: 'deleted' }))
    await upsertExport(h.state, makeRecord({ id: 'd', state: 'expired' }))
    const report = await h.run()
    expect(h.enqueued).toEqual([])
    expect(report).toEqual({ requeued: 0, expired: 0 })
    expect((await getExportRecord(h.state, 'a'))?.state).toBe('ready')
  })

  /**
   * Re-rendering hours of footage for a row the janitor is about to drop costs
   * a recording node an ffmpeg for nothing. It FAILS instead — named, because a
   * row that silently stays `queued` forever is exactly the defect this module
   * exists to remove.
   */
  it('fails an interrupted row whose life has already run out, rather than rendering it', async () => {
    const h = await harness()
    await upsertExport(h.state, makeRecord({ id: 'stale', state: 'queued', expiresAt: NOW - 1 }))
    const report = await h.run()
    expect(h.enqueued).toEqual([])
    expect(report).toEqual({ requeued: 0, expired: 1 })
    const row = await getExportRecord(h.state, 'stale')
    expect(row?.state).toBe('failed')
    expect(row?.error).toMatch(/restart/i)
  })

  it('says nothing when there is nothing to reconcile', async () => {
    const h = await harness()
    await upsertExport(h.state, makeRecord({ id: 'a', state: 'ready' }))
    await h.run()
    expect(h.warns).toEqual([])
  })

  it('reports every interrupted row it re-queued', async () => {
    const h = await harness()
    const warn = vi.fn()
    await upsertExport(h.state, makeRecord({ id: 'x', state: 'queued', deviceId: 101 }))
    await upsertExport(h.state, makeRecord({ id: 'y', state: 'rendering', deviceId: 1441 }))
    const report = await reconcileInterruptedExports({
      state: h.state,
      engine: { enqueue: () => undefined },
      now: () => NOW,
      logger: { info: () => undefined, debug: () => undefined, warn },
    })
    expect(report.requeued).toBe(2)
    // Every line about a device carries `tags: { deviceId }` — a miss is always
    // asked per-camera, and a line without it cannot answer that.
    const tagged = warn.mock.calls.map((c) => c[1]?.tags?.deviceId)
    expect(tagged).toContain(101)
    expect(tagged).toContain(1441)
  })
})
