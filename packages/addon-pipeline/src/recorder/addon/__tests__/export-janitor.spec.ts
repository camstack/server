import { describe, expect, it, vi } from 'vitest'
import type { ExportRecord } from '@camstack/types'
import { getExportRecord, upsertExport } from '../export-store.js'
import { makeExportsState } from './exports-state-fixture.js'
import { markDownloaded, sweepExpiredExports } from '../export-janitor.js'

function makeRecord(over: Partial<ExportRecord>): ExportRecord {
  return {
    id: 'e1',
    deviceId: 101,
    profile: 'main',
    fromMs: 0,
    toMs: 10_000,
    options: { speed: 1, includeAudio: true, maxLifeMs: 1, deleteAfterDownload: false },
    state: 'ready',
    progressPct: 100,
    fileBytes: 100,
    expiresAt: 1000,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: 1,
    createdBy: 'op',
    error: null,
    ...over,
  }
}

describe('sweepExpiredExports', () => {
  it('deletes the file and expires a ready row past expiresAt, keeping the row', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e1', expiresAt: 500 }))
    const removeFile = vi.fn(async () => {})
    const { expired } = await sweepExpiredExports(1000, {
      state,
      outPath: () => '/o/e1.mp4',
      removeFile,
    })
    expect(expired).toEqual(['e1'])
    expect(removeFile).toHaveBeenCalledWith('/o/e1.mp4')
    const rec = await getExportRecord(state, 'e1')
    expect(rec?.state).toBe('expired')
    expect(rec?.fileBytes).toBeNull()
  })

  it('leaves a not-yet-expired row alone', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e1', expiresAt: 5000 }))
    const { expired } = await sweepExpiredExports(1000, {
      state,
      outPath: () => '/o/e1.mp4',
      removeFile: vi.fn(async () => {}),
    })
    expect(expired).toEqual([])
    expect((await getExportRecord(state, 'e1'))?.state).toBe('ready')
  })

  it('skips non-ready rows (queued/failed/expired)', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'q', state: 'queued', expiresAt: 1 }))
    await upsertExport(state, makeRecord({ id: 'f', state: 'failed', expiresAt: 1 }))
    const { expired } = await sweepExpiredExports(1000, {
      state,
      outPath: () => '/o/x.mp4',
      removeFile: vi.fn(async () => {}),
    })
    expect(expired).toEqual([])
  })
})

describe('markDownloaded', () => {
  it('stamps downloadedAt and does nothing else when deleteAfterDownload is false', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e1', deleteAfterDownload: false }))
    await markDownloaded(
      'e1',
      777,
      { state, outPath: () => '/o/e1.mp4', removeFile: vi.fn() },
      (fn) => fn(),
      0,
    )
    const rec = await getExportRecord(state, 'e1')
    expect(rec?.downloadedAt).toBe(777)
    expect(rec?.state).toBe('ready')
  })

  it('deletes the file after the grace and flips to deleted when deleteAfterDownload', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e1', deleteAfterDownload: true }))
    const removeFile = vi.fn(async () => {})
    const scheduled: Array<() => void> = []
    await markDownloaded(
      'e1',
      777,
      { state, outPath: () => '/o/e1.mp4', removeFile },
      (fn) => scheduled.push(fn),
      60_000,
    )
    // Grace not yet elapsed
    expect(removeFile).not.toHaveBeenCalled()
    scheduled[0]!()
    await new Promise((r) => setTimeout(r, 5))
    expect(removeFile).toHaveBeenCalledWith('/o/e1.mp4')
    expect((await getExportRecord(state, 'e1'))?.state).toBe('deleted')
  })
})
