/**
 * An export ffmpeg that cannot be SPAWNED must fail the export, not the runner.
 *
 * Same class as the 2026-08-18 recording outage (`segment-writer-spawn-error.spec.ts`):
 * `child_process` emits `'error'` when the fork itself fails, and an `'error'`
 * with no listener is re-thrown as an uncaught exception. The export engine
 * lives in the SAME `recorder` runner as the segment writers, so a spawn
 * failure here killed the process that owns every camera's recording — for a
 * job an operator could simply have been told had failed.
 *
 * The fake child is a real `EventEmitter` for exactly the reason stated in the
 * writer's spec: only a real emitter reproduces "unhandled 'error' throws".
 */

import { EventEmitter } from 'node:events'
import type { ExportRecord, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ExportEngine } from '../export-engine.js'
import { getExportRecord, type RecordingExportsState, upsertExport } from '../export-store.js'
import { makeExportsState } from './exports-state-fixture.js'

function makeRecord(id: string): ExportRecord {
  return {
    id,
    deviceId: 101,
    profile: 'main',
    fromMs: 0,
    toMs: 10_000,
    options: { speed: 1, includeAudio: true, maxLifeMs: 1, deleteAfterDownload: false },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: 1,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: 1,
    createdBy: 'op',
    error: null,
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as IScopedLogger

/** A spawn fake with real emitter semantics that fails to fork. */
class FailingChild extends EventEmitter {
  readonly kill = vi.fn()
  readonly stderr = new EventEmitter()
}

async function waitForState(
  state: RecordingExportsState,
  id: string,
  target: string,
  ms = 1000,
): Promise<ExportRecord> {
  const deadline = Date.now() + ms
  for (;;) {
    const rec = await getExportRecord(state, id)
    if (rec && rec.state === target) return rec
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${target}, got ${rec?.state}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('ExportEngine: a spawn that fails', () => {
  it('fails the EXPORT (and keeps the runner alive) when ffmpeg cannot be spawned', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord('e-spawn'))
    const removeFile = vi.fn(async () => {})
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: () => {
        const child = new FailingChild()
        // Listeners are attached after `spawn` returns, so the failure has to
        // land on the next turn — which is what child_process does too.
        setImmediate(() => {
          child.emit('error', Object.assign(new Error('spawn ffmpeg EAGAIN'), { code: 'EAGAIN' }))
        })
        return child
      },
      logger,
      state,
      resolvePlaylist: async () => ({ path: '/p/master.m3u8', segments: [] }),
      outPath: () => '/o/e-spawn.mp4',
      statBytes: async () => 0,
      removeFile,
      emit: vi.fn(),
    })
    engine.enqueue('e-spawn')
    const rec = await waitForState(state, 'e-spawn', 'failed')
    // The operator is told WHY, and the partial output is cleaned up exactly as
    // on any other failure — one policy, not a second spawn-error path.
    expect(rec.error).toContain('EAGAIN')
    expect(removeFile).toHaveBeenCalledWith('/o/e-spawn.mp4')
  })
})

describe('ExportEngine: the pinned ffmpeg (D540)', () => {
  it('REFUSES the export by name, per camera, and spawns nothing when the pinned ffmpeg cannot be had', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord('e-nopin'))
    const spawn = vi.fn(() => new FailingChild())
    const error = vi.fn()
    const engine = new ExportEngine({
      resolveFfmpeg: async () => {
        throw new Error('download failed')
      },
      spawn,
      logger: { ...logger, error },
      state,
      resolvePlaylist: async () => ({ path: '/p/master.m3u8', segments: [] }),
      outPath: () => '/o/e-nopin.mp4',
      statBytes: async () => 0,
      removeFile: vi.fn(async () => {}),
      emit: vi.fn(),
    })
    engine.enqueue('e-nopin')
    const rec = await waitForState(state, 'e-nopin', 'failed')
    expect(rec.error).toContain('no pinned ffmpeg')
    expect(spawn).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('no pinned ffmpeg'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('spawns EXACTLY the pinned path it resolved', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord('e-pin'))
    const commands: string[] = []
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: (cmd) => {
        commands.push(cmd)
        const child = new FailingChild()
        setImmediate(() => child.emit('error', new Error('stop here')))
        return child
      },
      logger,
      state,
      resolvePlaylist: async () => ({ path: '/p/master.m3u8', segments: [] }),
      outPath: () => '/o/e-pin.mp4',
      statBytes: async () => 0,
      removeFile: vi.fn(async () => {}),
      emit: vi.fn(),
    })
    engine.enqueue('e-pin')
    await waitForState(state, 'e-pin', 'failed')
    expect(commands).toEqual(['/deps/ffmpeg-pinned'])
  })
})
