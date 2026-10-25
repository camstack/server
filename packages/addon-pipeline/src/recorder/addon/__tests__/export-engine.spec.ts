import type { ExportRecord, IScopedLogger } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { EXPORT_MIN_PLAUSIBLE_BYTES, ExportEngine } from '../export-engine.js'
import { getExportRecord, type RecordingExportsState, upsertExport } from '../export-store.js'
import { makeExportsState } from './exports-state-fixture.js'

function makeRecord(over: Partial<ExportRecord>): ExportRecord {
  return {
    id: 'e1',
    deviceId: 101,
    profile: 'main',
    fromMs: 0,
    toMs: 10_000,
    options: {
      speed: 1,
      includeAudio: true,
      maxLifeMs: 1,
      deleteAfterDownload: false,
    },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: 1,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: 1,
    createdBy: 'op',
    error: null,
    ...over,
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as IScopedLogger

interface FakeProc {
  kill: (sig?: NodeJS.Signals) => void
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  stderr: { on: (ev: string, cb: (...a: unknown[]) => void) => void }
}

/** Fake spawn: auto-drives stderr lines + exit unless `autoExit:false` (held
 *  live for cancel tests, where kill() triggers the exit). */
function makeSpawn(script: {
  stderr?: string[]
  exitCode?: number
  autoExit?: boolean
  killSignals?: NodeJS.Signals[]
}) {
  return (_cmd: string, _args: readonly string[]): FakeProc => {
    let onExit: ((code: unknown) => void) | null = null
    let onData: ((chunk: unknown) => void) | null = null
    const proc: FakeProc = {
      kill: (sig) => {
        script.killSignals?.push(sig ?? ('SIGTERM' as NodeJS.Signals))
        onExit?.(null)
      },
      on: (ev, cb) => {
        if (ev === 'exit') onExit = cb as (code: unknown) => void
      },
      stderr: {
        on: (ev, cb) => {
          if (ev === 'data') onData = cb as (chunk: unknown) => void
        },
      },
    }
    if (script.autoExit !== false) {
      setTimeout(() => {
        for (const l of script.stderr ?? []) onData?.(Buffer.from(l))
        onExit?.(script.exitCode ?? 0)
      }, 0)
    } else if (script.stderr !== undefined) {
      // Say the lines, then HOLD. This is the shape of the faststart pass: it
      // announces itself and then works in silence for as long as the file
      // takes, which a progress-armed watchdog reads as a hang.
      setTimeout(() => {
        for (const l of script.stderr ?? []) onData?.(Buffer.from(l))
      }, 0)
    }
    return proc
  }
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

describe('ExportEngine', () => {
  it('renders to ready with progress + fileBytes on exit 0', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e1' }))
    const emit = vi.fn()
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: makeSpawn({
        stderr: ['frame=1 time=00:00:05.00 bitrate=1'],
        exitCode: 0,
      }),
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e1.mp4',
      statBytes: async () => 4242,
      removeFile: async () => {},
      emit,
    })
    engine.enqueue('e1')
    const rec = await waitForState(state, 'e1', 'ready')
    expect(rec.fileBytes).toBe(4242)
    expect(rec.progressPct).toBe(100)
    expect(emit).toHaveBeenCalledWith(
      EventCategory.RecordingExportProgress,
      expect.objectContaining({ exportId: 'e1', progressPct: 50 }),
    )
    expect(emit).toHaveBeenCalledWith(
      EventCategory.RecordingExportCompleted,
      expect.objectContaining({ exportId: 'e1', fileBytes: 4242 }),
    )
  })

  it('marks failed and removes the partial on non-zero exit', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e2' }))
    const removeFile = vi.fn(async () => {})
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: makeSpawn({ stderr: ['boom: codec not supported'], exitCode: 1 }),
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e2.mp4',
      statBytes: async () => 0,
      removeFile,
      emit: vi.fn(),
    })
    engine.enqueue('e2')
    const rec = await waitForState(state, 'e2', 'failed')
    expect(rec.error).toContain('ffmpeg exited 1')
    expect(removeFile).toHaveBeenCalledWith('/o/e2.mp4')
  })

  it('fails fast when no footage covers the range', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e3' }))
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: makeSpawn({ exitCode: 0 }),
      logger,
      state,
      resolvePlaylist: async () => null,
      outPath: () => '/o/e3.mp4',
      statBytes: async () => 0,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e3')
    const rec = await waitForState(state, 'e3', 'failed')
    expect(rec.error).toContain('no footage')
  })

  it('drops the per-export source playlist on success AND on failure', async () => {
    for (const [id, exitCode] of [
      ['e5', 0],
      ['e6', 1],
    ] as const) {
      const state = await makeExportsState()
      await upsertExport(state, makeRecord({ id }))
      const cleanupPlaylist = vi.fn(async () => {})
      const engine = new ExportEngine({
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        spawn: makeSpawn({ exitCode }),
        logger,
        state,
        resolvePlaylist: async () => ({
          path: `/d/exports/101/${id}.src.m3u8`,
          concatPath: `/d/exports/101/${id}.src.ffconcat`,
          segments: [],
        }),
        cleanupPlaylist,
        outPath: () => `/o/${id}.mp4`,
        // A plausible render size: below EXPORT_MIN_PLAUSIBLE_BYTES the engine
        // treats exit 0 as an EMPTY render and fails it (see below).
        statBytes: async () => 4242,
        removeFile: async () => {},
        emit: vi.fn(),
      })
      engine.enqueue(id)
      await waitForState(state, id, exitCode === 0 ? 'ready' : 'failed')
      expect(cleanupPlaylist).toHaveBeenCalledWith(`/d/exports/101/${id}.src.m3u8`)
    }
  })

  it('logs the full ffmpeg stderr on a non-zero exit', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e7' }))
    const error = vi.fn()
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: makeSpawn({
        stderr: ['Error opening input files: Invalid data'],
        exitCode: 183,
      }),
      logger: { ...logger, error } as unknown as IScopedLogger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/e7.src.m3u8',
        concatPath: '/p/e7.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e7.mp4',
      statBytes: async () => 0,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e7')
    await waitForState(state, 'e7', 'failed')
    expect(error).toHaveBeenCalledWith(
      'export ffmpeg failed',
      expect.objectContaining({
        meta: expect.objectContaining({
          exportId: 'e7',
          code: 183,
          stderr: expect.stringContaining('Invalid data'),
        }),
      }),
    )
  })

  it('cancel SIGKILLs an in-flight render and removes the partial', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e4' }))
    const killSignals: NodeJS.Signals[] = []
    const removeFile = vi.fn(async () => {})
    const cleanupPlaylist = vi.fn(async () => {})
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: makeSpawn({ autoExit: false, killSignals }),
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/e4.src.m3u8',
        concatPath: '/p/e4.src.ffconcat',
        segments: [],
      }),
      cleanupPlaylist,
      outPath: () => '/o/e4.mp4',
      statBytes: async () => 0,
      removeFile,
      emit: vi.fn(),
    })
    engine.enqueue('e4')
    await waitForState(state, 'e4', 'rendering')
    await engine.cancel('e4')
    const rec = await waitForState(state, 'e4', 'failed')
    expect(rec.error).toBe('cancelled')
    expect(killSignals).toContain('SIGKILL')
    expect(removeFile).toHaveBeenCalledWith('/o/e4.mp4')
    expect(cleanupPlaylist).toHaveBeenCalledWith('/p/e4.src.m3u8')
  })

  // The 2026-08-12 incident: a timelapse whose frame-select matched nothing
  // produced a 262-byte MP4 (ftyp + moov + an EMPTY mdat, `nb_streams=0`),
  // ffmpeg exited 0, the engine stamped `ready`, and the file was republished
  // and delivered to a phone as a "damaged video". Exit 0 is not the same
  // question as "the file holds a frame".
  it('marks failed and removes the file when the render produced no frames', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e9' }))
    const removeFile = vi.fn(async () => {})
    const emit = vi.fn()
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: makeSpawn({ exitCode: 0 }),
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e9.mp4',
      statBytes: async () => EXPORT_MIN_PLAUSIBLE_BYTES - 1,
      removeFile,
      emit,
    })
    engine.enqueue('e9')
    const rec = await waitForState(state, 'e9', 'failed')
    expect(rec.error).toContain('no video frames')
    expect(removeFile).toHaveBeenCalledWith('/o/e9.mp4')
    expect(emit).not.toHaveBeenCalledWith(EventCategory.RecordingExportCompleted, expect.anything())
  })

  // The 2026-08-13 incident: dense ranges were planned in WALL time and handed
  // straight to a `select` predicate whose `t` runs over the CONCATENATION with
  // recording gaps removed. Every range past the first gap missed, and the
  // video was uniform while the log said `denseRanges=5`. The engine is the
  // last place that can still tell the two clocks apart — it holds both the
  // record's `fromMs` and the playlist's segments.
  it('hands ffmpeg dense ranges in STREAM time, not the wall time it was given', async () => {
    const state = await makeExportsState()
    const fromMs = 1_786_561_200_000
    await upsertExport(
      state,
      makeRecord({
        id: 'e11',
        fromMs,
        toMs: fromMs + 70_000,
        options: {
          includeAudio: false,
          maxLifeMs: 1,
          deleteAfterDownload: false,
          // Wall 55–65 s: after a 30 s hole in the recording.
          timelapse: {
            everyMs: 30_000,
            outputFps: 12,
            dense: { everyMs: 1000, ranges: [{ fromSec: 55, toSec: 65 }] },
          },
        },
      }),
    )
    const spawned: string[][] = []
    const info = vi.fn()
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: (_cmd, args) => {
        spawned.push([...args])
        return makeSpawn({ exitCode: 0 })(_cmd, args)
      },
      logger: { ...logger, info } as unknown as IScopedLogger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/e11.src.m3u8',
        concatPath: '/p/e11.src.ffconcat',
        // Footage 0–20 s and 50–70 s of wall time.
        segments: [
          { startMs: fromMs, durMs: 20_000 },
          { startMs: fromMs + 50_000, durMs: 20_000 },
        ],
      }),
      outPath: () => '/o/e11.mp4',
      statBytes: async () => 4242,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e11')
    await waitForState(state, 'e11', 'ready')

    // Pass 1 reads the FFCONCAT list through the concat demuxer — declared
    // durations, the same numbers the dense map summed. Never the HLS playlist.
    const pass1 = spawned[0] ?? []
    expect(pass1.slice(0, 10)).toEqual([
      '-fflags',
      '+discardcorrupt+genpts',
      '-err_detect',
      'ignore_err',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      '/p/e11.src.ffconcat',
    ])
    const filter = spawned
      .find((a) => a.some((x) => x.startsWith("select='")))
      ?.find((x) => x.startsWith("select='"))
    expect(filter).toContain('between(t,25,35)')
    expect(filter).not.toContain('between(t,55,65)')
    // Requested vs mapped is the only line that separates "quiet night" from
    // "every range missed".
    expect(info).toHaveBeenCalledWith(
      'export dense ranges mapped onto the concatenated stream',
      expect.objectContaining({
        tags: { deviceId: 101 },
        meta: expect.objectContaining({
          denseRangesRequested: 1,
          denseRangesMapped: 1,
        }),
      }),
    )
  })

  it('warns and renders uniform when every dense range fell in a recording gap', async () => {
    const state = await makeExportsState()
    const fromMs = 1_786_561_200_000
    await upsertExport(
      state,
      makeRecord({
        id: 'e12',
        fromMs,
        toMs: fromMs + 70_000,
        options: {
          includeAudio: false,
          maxLifeMs: 1,
          deleteAfterDownload: false,
          timelapse: {
            everyMs: 30_000,
            dense: { everyMs: 1000, ranges: [{ fromSec: 25, toSec: 45 }] },
          },
        },
      }),
    )
    const spawned: string[][] = []
    const warn = vi.fn()
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: (_cmd, args) => {
        spawned.push([...args])
        return makeSpawn({ exitCode: 0 })(_cmd, args)
      },
      logger: { ...logger, warn } as unknown as IScopedLogger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/e12.src.m3u8',
        concatPath: '/p/e12.src.ffconcat',
        segments: [
          { startMs: fromMs, durMs: 20_000 },
          { startMs: fromMs + 50_000, durMs: 20_000 },
        ],
      }),
      outPath: () => '/o/e12.mp4',
      statBytes: async () => 4242,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e12')
    await waitForState(state, 'e12', 'ready')

    const filter = spawned
      .find((a) => a.some((x) => x.startsWith("select='")))
      ?.find((x) => x.startsWith("select='"))
    // Uniform, and a VALID filter: an empty range list would emit `if(,…)` and
    // fail the render outright.
    expect(filter).not.toContain('between(')
    expect(filter).toContain('gte(t-prev_selected_t,30)')
    expect(warn).toHaveBeenCalledWith(
      'export dense ranges mapped onto the concatenated stream',
      expect.objectContaining({
        tags: { deviceId: 101 },
        meta: expect.objectContaining({
          denseRangesRequested: 1,
          denseRangesMapped: 0,
          denseRangesDropped: [{ fromSec: 25, toSec: 45, reason: 'gap' }],
        }),
      }),
    )
  })

  it('still accepts a small but non-empty render', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e10' }))
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: makeSpawn({ exitCode: 0 }),
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e10.mp4',
      statBytes: async () => EXPORT_MIN_PLAUSIBLE_BYTES,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e10')
    const rec = await waitForState(state, 'e10', 'ready')
    expect(rec.fileBytes).toBe(EXPORT_MIN_PLAUSIBLE_BYTES)
  })

  it('timelapse concatenates first, then selects — two ffmpeg spawns', async () => {
    const state = await makeExportsState()
    await upsertExport(
      state,
      makeRecord({
        id: 'e-tl',
        options: {
          includeAudio: false,
          maxLifeMs: 1,
          deleteAfterDownload: false,
          timelapse: { everyMs: 2000, outputFps: 30 },
        },
      }),
    )
    const calls: string[][] = []
    const scripts = [
      { stderr: ['time=00:00:05.00'], exitCode: 0 },
      { stderr: ['time=00:00:00.50'], exitCode: 0 },
    ]
    let i = 0
    const removeFile = vi.fn(async () => {})
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: (cmd, args) => {
        calls.push([...args])
        const script = scripts[i] ?? { exitCode: 0 }
        i += 1
        return makeSpawn(script)(cmd, args)
      },
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e-tl.mp4',
      statBytes: async () => 4242,
      removeFile,
      emit: vi.fn(),
    })
    engine.enqueue('e-tl')
    const rec = await waitForState(state, 'e-tl', 'ready')
    expect(rec.fileBytes).toBe(4242)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.join(' ')).toContain('-c copy')
    expect(calls[0]?.join(' ')).toContain('/o/e-tl.concat.ts')
    expect(calls[0]?.join(' ')).not.toContain('select=')
    expect(calls[1]?.join(' ')).toContain('select=')
    expect(calls[1]).toContain('/o/e-tl.mp4')
    expect(removeFile).toHaveBeenCalledWith('/o/e-tl.concat.ts')
  })

  it('timelapse fails the job if the concat pass exits non-zero and never selects', async () => {
    const state = await makeExportsState()
    await upsertExport(
      state,
      makeRecord({
        id: 'e-tl-fail',
        options: {
          includeAudio: false,
          maxLifeMs: 1,
          deleteAfterDownload: false,
          timelapse: { everyMs: 2000 },
        },
      }),
    )
    const calls: string[][] = []
    const removeFile = vi.fn(async () => {})
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: (cmd, args) => {
        calls.push([...args])
        return makeSpawn({ stderr: ['Error opening input'], exitCode: 183 })(cmd, args)
      },
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e-tl-fail.mp4',
      statBytes: async () => 0,
      removeFile,
      emit: vi.fn(),
    })
    engine.enqueue('e-tl-fail')
    const rec = await waitForState(state, 'e-tl-fail', 'failed')
    expect(rec.error).toContain('ffmpeg exited 183')
    expect(calls).toHaveLength(1)
    expect(removeFile).toHaveBeenCalledWith('/o/e-tl-fail.concat.ts')
  })

  it('a 10 h timelapse is hour-chunks, not one concat — a dead hour is skipped', async () => {
    const state = await makeExportsState()
    await upsertExport(
      state,
      makeRecord({
        id: 'e-chunks',
        fromMs: 0,
        toMs: 2 * 3_600_000,
        options: {
          includeAudio: false,
          maxLifeMs: 1,
          deleteAfterDownload: false,
          timelapse: { everyMs: 30_000, outputFps: 12 },
        },
      }),
    )
    const calls: string[][] = []
    let n = 0
    const writeTextFile = vi.fn(async () => {})
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: (_cmd, args) => {
        calls.push([...args])
        n += 1
        // First chunk concat dies (corrupt hour). Everything else succeeds.
        const exit = n === 1 ? 183 : 0
        return makeSpawn({ exitCode: exit })(_cmd, args)
      },
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/e-chunks.src.m3u8',
        concatPath: '/p/e-chunks.src.ffconcat',
        segments: [
          { startMs: 0, durMs: 3_600_000 },
          { startMs: 3_600_000, durMs: 3_600_000 },
        ],
        concatEntries: [
          { uri: '/rec/a.m4s', durMs: 3_600_000 },
          { uri: '/rec/b.m4s', durMs: 3_600_000 },
        ],
      }),
      writeTextFile,
      outPath: () => '/o/e-chunks.mp4',
      statBytes: async () => 4242,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e-chunks')
    const rec = await waitForState(state, 'e-chunks', 'ready')
    expect(rec.fileBytes).toBe(4242)
    // Hour 0 concat failed → no select for that hour. Hour 1 concat+select, then
    // a final assemble of the surviving clips.
    const concats = calls.filter((a) => a.includes('concat') && a.includes('-c'))
    const selects = calls.filter((a) => a.some((x) => x.startsWith("select='")))
    expect(concats.length).toBeGreaterThanOrEqual(2) // failed hour + surviving hour [+ assemble]
    expect(selects).toHaveLength(1)
    expect(writeTextFile).toHaveBeenCalled()
  })

  it('two queued exports start together — a hung timelapse does not own the spindle', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'a' }))
    await upsertExport(state, makeRecord({ id: 'b' }))
    let spawned = 0
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: () => {
        spawned += 1
        return makeSpawn({ autoExit: false })('ffmpeg', [])
      },
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: (rec) => `/o/${rec.id}.mp4`,
      statBytes: async () => 4242,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    // Hold the fake children open so we can see both forks before either exits.
    const orig = engine as unknown as { enqueue: (id: string) => void }
    orig.enqueue('a')
    orig.enqueue('b')
    await vi.waitFor(() => expect(spawned).toBe(2), { timeout: 500 })
    expect(spawned).toBe(2)
  })

  it('kills a concat that prints no time= — that is the 0% hang, not a slow hour', async () => {
    const state = await makeExportsState()
    await upsertExport(
      state,
      makeRecord({
        id: 'e-stall',
        options: {
          includeAudio: false,
          maxLifeMs: 1,
          deleteAfterDownload: false,
          timelapse: { everyMs: 2000 },
        },
      }),
    )
    const killSignals: NodeJS.Signals[] = []
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      stallMs: 40,
      spawn: makeSpawn({ autoExit: false, killSignals }),
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e-stall.mp4',
      statBytes: async () => 0,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e-stall')
    await waitForState(state, 'e-stall', 'rendering')
    await new Promise((r) => setTimeout(r, 80))
    const rec = await waitForState(state, 'e-stall', 'failed')
    expect(killSignals).toContain('SIGKILL')
    expect(rec.error).toMatch(/stall|killed|no progress/i)
  })

  /**
   * 2026-09-10, export 62232d7a on device 104. The render finished its first
   * pass and died with `code=null` — SIGKILL — after this, verbatim:
   *
   * ```
   * [mp4 @ …] Starting second pass: moving the moov atom to the beginning of the file
   * ffmpeg stalled: no progress for 90000ms
   * ```
   *
   * The faststart pass rewrites the whole file and emits NO `time=` line while
   * it does. The watchdog re-arms only on `time=`, so the silence that pass is
   * MADE OF read as a hang, and a process doing exactly its job was killed.
   * The bigger the export, the more certain the kill.
   */
  it('does not kill the faststart pass, whose silence is the work', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e-faststart' }))
    const killSignals: NodeJS.Signals[] = []
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      stallMs: 30,
      spawn: makeSpawn({
        autoExit: false,
        killSignals,
        stderr: [
          '[mp4 @ 0x1] Starting second pass: moving the moov atom to the beginning of the file',
        ],
      }),
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e-faststart.mp4',
      statBytes: async () => 4242,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e-faststart')
    await waitForState(state, 'e-faststart', 'rendering')
    // Four times the progress budget. Still working, still alive.
    await new Promise((r) => setTimeout(r, 120))
    expect(killSignals).not.toContain('SIGKILL')
  })

  it('still kills a faststart pass that overruns ITS budget — the guard is not disabled', async () => {
    const state = await makeExportsState()
    await upsertExport(state, makeRecord({ id: 'e-faststart-hung' }))
    const killSignals: NodeJS.Signals[] = []
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      stallMs: 20,
      faststartStallMs: 60,
      spawn: makeSpawn({
        autoExit: false,
        killSignals,
        stderr: [
          '[mp4 @ 0x1] Starting second pass: moving the moov atom to the beginning of the file',
        ],
      }),
      logger,
      state,
      resolvePlaylist: async () => ({
        path: '/p/master.m3u8',
        concatPath: '/p/master.src.ffconcat',
        segments: [],
      }),
      outPath: () => '/o/e-faststart-hung.mp4',
      statBytes: async () => 0,
      removeFile: async () => {},
      emit: vi.fn(),
    })
    engine.enqueue('e-faststart-hung')
    await waitForState(state, 'e-faststart-hung', 'rendering')
    await new Promise((r) => setTimeout(r, 140))
    expect(killSignals).toContain('SIGKILL')
  })
})
