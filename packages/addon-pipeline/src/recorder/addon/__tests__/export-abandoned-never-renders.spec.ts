/**
 * An export its caller abandoned is never rendered for nobody (D686 fix round).
 *
 * The notification centre waits for a recorded cut for at most 30 s. When the
 * recorder is wedged (a timelapse holding both lanes) the cut is still QUEUED
 * at the deadline, and the caller gives up. Before this, `deleteExport` removed
 * the file and marked the row `deleted` while the engine kept the id in its
 * queue: `render()` then patched the row back to `rendering`, ran ffmpeg for
 * nobody and left the file on disk until the janitor's 15 min.
 *
 * Driven through the REAL provider and the REAL engine sharing one store — a
 * fake `deleteExport` is what let the original test pass.
 */
import type { ExportOptions, ExportRecord, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { EXPORT_MAX_CONCURRENT, ExportEngine } from '../export-engine.js'
import { getExportRecord, patchExport } from '../export-store.js'
import {
  buildRecordingExportProvider,
  type ExportRecordingIndex,
} from '../recording-export-provider.js'
import { makeExportsState } from './exports-state-fixture.js'

const silent: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
  withTags: () => silent,
}

const OPTIONS: ExportOptions = {
  speed: 1,
  includeAudio: false,
  maxLifeMs: 900_000,
  deleteAfterDownload: false,
}

const INDEX: ExportRecordingIndex = {
  segmentsInWindow: async () => [{ startMs: 0, durMs: 60_000 }],
}

interface HeldProc {
  readonly args: readonly string[]
  exit(code: number | null): void
}

async function world() {
  const state = await makeExportsState()
  const held: HeldProc[] = []
  const removed: string[] = []
  const outPath = (rec: ExportRecord): string => `/o/${rec.id}.mp4`
  const engine = new ExportEngine({
    resolveFfmpeg: async () => '/deps/ffmpeg',
    spawn: (_cmd, args) => {
      let onExit: ((code: unknown) => void) | null = null
      const proc = {
        kill: () => onExit?.(null),
        on: (ev: string, cb: (...a: unknown[]) => void) => {
          if (ev === 'exit') onExit = cb as (code: unknown) => void
        },
        stderr: { on: () => {} },
      }
      held.push({ args, exit: (code) => onExit?.(code) })
      return proc
    },
    logger: silent,
    state,
    resolvePlaylist: async () => ({ path: '/p/m.m3u8', concatPath: '/p/m.ffconcat', segments: [] }),
    outPath,
    statBytes: async () => 50_000,
    removeFile: async (p) => void removed.push(p),
    emit: () => {},
  })
  let seq = 0
  const provider = buildRecordingExportProvider({
    state,
    engine,
    index: INDEX,
    clipCatalog: { listClips: async () => [] },
    now: () => 5_000,
    newId: () => `exp-${++seq}`,
    createdBy: () => 'nc',
    outPath,
    removeFile: async (p) => void removed.push(p),
    downloadUrlFor: (id) => `/x/${id}`,
    statBytes: async () => 50_000,
    readFile: async () => Buffer.from('mp4'),
    logger: silent,
  })
  const create = () =>
    provider.createExport({
      deviceId: 101,
      profile: 'low',
      fromMs: 1_000,
      toMs: 11_000,
      options: OPTIONS,
    })
  return { state, held, removed, provider, create }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('an abandoned export', () => {
  it('a QUEUED export the caller cancels and deletes never reaches ffmpeg', async () => {
    const w = await world()
    // Both lanes busy: the timelapse the notification got stuck behind.
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i += 1) await w.create()
    await settle()
    expect(w.held).toHaveLength(EXPORT_MAX_CONCURRENT)
    const abandoned = await w.create()
    await w.provider.cancelExport({ exportId: abandoned.id })
    await w.provider.deleteExport({ exportId: abandoned.id })
    // The lanes free up.
    for (const p of [...w.held]) p.exit(0)
    await settle()
    expect(w.held.some((p) => p.args.includes(`/o/${abandoned.id}.mp4`))).toBe(false)
    expect((await getExportRecord(w.state, abandoned.id))?.state).toBe('deleted')
  })

  it('a queued export that is only DELETED is not rendered either', async () => {
    const w = await world()
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i += 1) await w.create()
    await settle()
    const abandoned = await w.create()
    await w.provider.deleteExport({ exportId: abandoned.id })
    for (const p of [...w.held]) p.exit(0)
    await settle()
    expect(w.held.some((p) => p.args.includes(`/o/${abandoned.id}.mp4`))).toBe(false)
    expect((await getExportRecord(w.state, abandoned.id))?.state).toBe('deleted')
  })

  it('a RUNNING export that is cancelled and deleted is killed and its file removed', async () => {
    const w = await world()
    const running = await w.create()
    await settle()
    expect(w.held).toHaveLength(1)
    await w.provider.cancelExport({ exportId: running.id })
    await w.provider.deleteExport({ exportId: running.id })
    await settle()
    const row = await getExportRecord(w.state, running.id)
    expect(row?.state).toBe('deleted')
    expect(w.removed.filter((p) => p === `/o/${running.id}.mp4`).length).toBeGreaterThan(0)
  })

  it('a cancel that finalises AFTER the delete leaves the row deleted, not failed', async () => {
    const w = await world()
    const running = await w.create()
    await settle()
    await w.provider.deleteExport({ exportId: running.id })
    await w.provider.cancelExport({ exportId: running.id })
    await settle()
    expect((await getExportRecord(w.state, running.id))?.state).toBe('deleted')
  })

  it('a render that finishes after its row was deleted is not published as ready', async () => {
    const w = await world()
    const running = await w.create()
    await settle()
    // Deleted WITHOUT a cancel (an older caller): ffmpeg runs on and exits 0.
    await w.provider.deleteExport({ exportId: running.id })
    w.held[0]?.exit(0)
    await settle()
    const row = await getExportRecord(w.state, running.id)
    expect(row?.state).toBe('deleted')
    expect(w.removed.filter((p) => p === `/o/${running.id}.mp4`).length).toBe(2)
  })

  it("a delete that lands between the engine's read and its claim is not overwritten (R5)", async () => {
    const w = await world()
    for (let i = 0; i < EXPORT_MAX_CONCURRENT; i += 1) await w.create()
    await settle()
    const abandoned = await w.create()
    // The race, made deterministic: the moment the engine first reads the
    // queued row, a delete WITHOUT a cancel lands — after the value was read,
    // before the engine claims the row for rendering.
    const read = w.state.get.bind(w.state)
    let armed = true
    vi.spyOn(w.state, 'get').mockImplementation(async (id: string) => {
      const row = await read(id)
      if (armed && id === abandoned.id) {
        armed = false
        await patchExport(w.state, id, { state: 'deleted', fileBytes: null })
      }
      return row
    })
    for (const p of [...w.held]) p.exit(0)
    await settle()
    expect(w.held.some((p) => p.args.includes(`/o/${abandoned.id}.mp4`))).toBe(false)
    expect((await getExportRecord(w.state, abandoned.id))?.state).toBe('deleted')
  })
})
