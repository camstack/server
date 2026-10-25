import { describe, expect, it } from 'vitest'
import type { ExportRecord } from '@camstack/types'
import {
  type RecordingExportsState,
  getExportRecord,
  listExportsFor,
  patchExport,
  patchExportUnless,
  recordingExportsState,
  removeExport,
  upsertExport,
} from '../export-store.js'
import { makeRecorderRecords } from './fake-records.js'

/** A declared, empty `recorder`/`exports` handle on a fresh in-memory world. */
async function fakeState(): Promise<RecordingExportsState> {
  const world = await makeRecorderRecords()
  return recordingExportsState(world.records)
}

function makeRecord(over: Partial<ExportRecord>): ExportRecord {
  return {
    id: 'e1',
    deviceId: 101,
    profile: 'main',
    fromMs: 1000,
    toMs: 2000,
    options: { speed: 1, includeAudio: true, maxLifeMs: 604_800_000, deleteAfterDownload: false },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: 604_808_000,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: 5000,
    createdBy: 'op',
    error: null,
    ...over,
  }
}

describe('export-store (RecordKindHandle)', () => {
  it('upsert + patch round-trips and reads back', async () => {
    const s = await fakeState()
    await upsertExport(s, makeRecord({ id: 'e1' }))
    await patchExport(s, 'e1', { state: 'ready', fileBytes: 1234, progressPct: 100 })
    const got = await getExportRecord(s, 'e1')
    expect(got?.state).toBe('ready')
    expect(got?.fileBytes).toBe(1234)
  })

  it('patch on unknown id returns null', async () => {
    const s = await fakeState()
    expect(await patchExport(s, 'nope', { state: 'ready' })).toBeNull()
  })

  it('list filters by device and sorts newest-first (by createdAt / record at)', async () => {
    const s = await fakeState()
    await upsertExport(s, makeRecord({ id: 'a', deviceId: 101, createdAt: 100 }))
    await upsertExport(s, makeRecord({ id: 'b', deviceId: 101, createdAt: 300 }))
    await upsertExport(s, makeRecord({ id: 'c', deviceId: 999, createdAt: 200 }))
    expect((await listExportsFor(s, 101)).map((r) => r.id)).toEqual(['b', 'a'])
    expect((await listExportsFor(s, 999)).map((r) => r.id)).toEqual(['c'])
    expect((await listExportsFor(s)).length).toBe(3)
  })

  it('remove drops the row', async () => {
    const s = await fakeState()
    await upsertExport(s, makeRecord({ id: 'e1' }))
    await removeExport(s, 'e1')
    expect(await getExportRecord(s, 'e1')).toBeNull()
  })

  it('patchExportUnless refuses when the gate fires', async () => {
    const s = await fakeState()
    await upsertExport(s, makeRecord({ id: 'x', state: 'ready' }))
    const result = await patchExportUnless(s, 'x', { state: 'deleted' }, (r) => r.state === 'ready')
    expect(result.kind).toBe('refused')
    const row = await getExportRecord(s, 'x')
    expect(row?.state).toBe('ready')
  })

  it('patchExportUnless patches when the gate does not fire', async () => {
    const s = await fakeState()
    await upsertExport(s, makeRecord({ id: 'x', state: 'queued' }))
    const result = await patchExportUnless(
      s,
      'x',
      { state: 'rendering', progressPct: 0 },
      (r) => r.state === 'ready',
    )
    expect(result.kind).toBe('patched')
    const row = await getExportRecord(s, 'x')
    expect(row?.state).toBe('rendering')
  })

  it('patchExportUnless returns missing when id does not exist', async () => {
    const s = await fakeState()
    const result = await patchExportUnless(s, 'ghost', { state: 'deleted' }, () => false)
    expect(result.kind).toBe('missing')
  })

  it('the record `at` is set to createdAt so ordering by newest is by createdAt', async () => {
    const world = await makeRecorderRecords()
    const s = recordingExportsState(world.records)
    await upsertExport(s, makeRecord({ id: 'old', createdAt: 100 }))
    await upsertExport(s, makeRecord({ id: 'new', createdAt: 900 }))
    // The fake transport stores `at` and sorts by it when `desc: true`
    const rows = await listExportsFor(s)
    expect(rows[0]?.id).toBe('new')
    expect(rows[1]?.id).toBe('old')
  })

  /**
   * The whole blob round-trips on every mutation, so two overlapping
   * read-modify-write cycles silently discard one of them — last writer wins.
   *
   * This is not theoretical. On 2026-08-14 the engine was patching
   * `progressPct` about once a second for an in-flight render while the
   * timelapse scheduler called `createExport` for camera 101; the new row was
   * written between a progress patch's read and its write, and five seconds
   * later `getExport` answered `unknown export "547ea182-…"`. The camera's
   * whole night was lost to it.
   */
  describe('concurrent mutations', () => {
    /**
     * A handle whose read and write each yield, so two cycles can interleave.
     */
    async function slowState(): Promise<RecordingExportsState> {
      const world = await makeRecorderRecords()

      const yieldTurn = async (): Promise<void> => {
        await Promise.resolve()
        await Promise.resolve()
      }

      // Wrap the records facade with per-operation delays.
      const base = recordingExportsState(world.records)
      const slow: RecordingExportsState = {
        ...base,
        get: async (id) => {
          await yieldTurn()
          return base.get(id)
        },
        put: async (input, opts) => {
          await yieldTurn()
          return base.put(input, opts)
        },
        delete: async (id) => {
          await yieldTurn()
          return base.delete(id)
        },
      }
      return slow
    }

    it('never loses an inserted row to an overlapping patch', async () => {
      const s = await slowState()
      await upsertExport(s, makeRecord({ id: 'rendering-1', state: 'rendering' }))
      await Promise.all([
        patchExport(s, 'rendering-1', { progressPct: 40 }),
        upsertExport(s, makeRecord({ id: 'created-mid-render', createdAt: 9000 })),
      ])
      expect(await getExportRecord(s, 'created-mid-render')).not.toBeNull()
      expect((await getExportRecord(s, 'rendering-1'))?.progressPct).toBe(40)
    })

    /**
     * The one race a per-ROW upsert does NOT close: two patches of the SAME
     * export are still read-modify-write of one row. `serialize` is keyed by
     * export id precisely for this — remove it and the second patch's read sees
     * the pre-first snapshot and drops `fileBytes`.
     */
    it('never loses one patch to another patch of the SAME export', async () => {
      const s = await slowState()
      await upsertExport(s, makeRecord({ id: 'a', state: 'rendering' }))
      await Promise.all([
        patchExport(s, 'a', { fileBytes: 4242 }),
        patchExport(s, 'a', { progressPct: 70 }),
      ])
      const got = await getExportRecord(s, 'a')
      expect(got?.fileBytes).toBe(4242)
      expect(got?.progressPct).toBe(70)
    })

    it('never loses a patch to an overlapping insert', async () => {
      const s = await slowState()
      await upsertExport(s, makeRecord({ id: 'a', state: 'rendering' }))
      await upsertExport(s, makeRecord({ id: 'b', state: 'rendering' }))
      await Promise.all([
        patchExport(s, 'a', { state: 'ready', fileBytes: 11 }),
        patchExport(s, 'b', { state: 'ready', fileBytes: 22 }),
        upsertExport(s, makeRecord({ id: 'c' })),
        removeExport(s, 'nonexistent'),
      ])
      expect((await getExportRecord(s, 'a'))?.fileBytes).toBe(11)
      expect((await getExportRecord(s, 'b'))?.fileBytes).toBe(22)
      expect(await getExportRecord(s, 'c')).not.toBeNull()
    })
  })
})
