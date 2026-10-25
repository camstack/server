import { describe, expect, it, vi } from 'vitest'
import { RECORDING_EXPORT_MAX_READ_BYTES } from '@camstack/types'
import type { ExportOptions, ExportState } from '@camstack/types'
import {
  getExportRecord,
  listExportsFor,
  patchExport,
  type RecordingExportsState,
} from '../export-store.js'
import { makeExportsState } from './exports-state-fixture.js'
import {
  buildRecordingExportProvider,
  exportFileName,
  type ExportEngineHandle,
  type ExportRecordingIndex,
  type RecordingExportProviderDeps,
} from '../recording-export-provider.js'

/** In-memory durable handle for tests (production uses BaseAddon.state()). */

/**
 * Index stub: `main` has one 10s segment at t=0; every other profile is empty.
 *
 * **It is LAZY, like production.** `RecordingIndex` is populated per hour by
 * `hydrateWindowFromStorage`; a window nobody has walked yet answers EMPTY even
 * though the footage is on disk, and the archive-wide walk takes minutes after a
 * restart. The old stub returned its row unconditionally — it supplied the value
 * production forgot to fetch, which is exactly why a green suite shipped a gate
 * that refused every export of an un-walked window.
 *
 * `hydratedWindows` records what the provider asked to be hydrated, so a test
 * can assert the gate hydrates BEFORE it reads.
 */
function fakeIndex(): ExportRecordingIndex & { readonly hydratedWindows: string[] } {
  const hydratedWindows: string[] = []
  const hydrated = new Set<string>()
  const key = (deviceId: number, fromMs: number, toMs: number): string =>
    `${deviceId}:${fromMs}-${toMs}`
  return {
    hydratedWindows,
    segmentsInWindow: async (deviceId, profile, fromMs, toMs) => {
      const k = key(deviceId, fromMs, toMs)
      if (!hydrated.has(k)) {
        hydrated.add(k)
        hydratedWindows.push(k)
      }
      return profile === 'main' ? [{ startMs: 0, durMs: 10_000 }] : []
    },
  }
}

const OPTIONS: ExportOptions = {
  speed: 1,
  includeAudio: true,
  maxLifeMs: 604_800_000,
  deleteAfterDownload: false,
}

function makeLogger(): RecordingExportProviderDeps['logger'] {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

const EMPTY_CLIP_CATALOG: RecordingExportProviderDeps['clipCatalog'] = {
  listClips: async () => [],
}

async function makeDeps(over: Partial<RecordingExportProviderDeps> = {}): Promise<{
  deps: RecordingExportProviderDeps
  engine: ExportEngineHandle & { enqueued: string[]; cancelled: string[] }
  state: RecordingExportsState
  removed: string[]
}> {
  const enqueued: string[] = []
  const cancelled: string[] = []
  const engine = {
    enqueue: (id: string) => void enqueued.push(id),
    cancel: (id: string) => void cancelled.push(id),
    enqueued,
    cancelled,
  }
  const removed: string[] = []
  const state = over.state ?? (await makeExportsState())
  let seq = 0
  const deps: RecordingExportProviderDeps = {
    state,
    engine,
    index: fakeIndex(),
    clipCatalog: EMPTY_CLIP_CATALOG,
    now: () => 5_000,
    newId: () => `exp-${++seq}`,
    createdBy: () => 'tester',
    outPath: (rec) => `/data/exports/${rec.deviceId}/${rec.id}.mp4`,
    removeFile: async (p) => void removed.push(p),
    downloadUrlFor: (id) => `/addon/recorder/exports/${id}.mp4`,
    statBytes: async () => 4,
    readFile: async () => Buffer.from('mp4!'),
    logger: makeLogger(),
    ...over,
  }
  return { deps, engine, state, removed }
}

describe('recording-export provider', () => {
  it('createExport with footage → persists queued record and enqueues it', async () => {
    const { deps, engine, state } = await makeDeps()
    const provider = buildRecordingExportProvider(deps)

    const rec = await provider.createExport({
      deviceId: 101,
      profile: 'main',
      fromMs: 1_000,
      toMs: 6_000,
      options: OPTIONS,
    })

    expect(rec.state).toBe('queued')
    expect(rec.progressPct).toBeNull()
    expect(rec.fileBytes).toBeNull()
    expect(rec.createdAt).toBe(5_000)
    expect(rec.expiresAt).toBe(5_000 + OPTIONS.maxLifeMs)
    expect(rec.createdBy).toBe('tester')
    expect(engine.enqueued).toEqual([rec.id])
    expect(await getExportRecord(state, rec.id)).not.toBeNull()
  })

  it('createExport with profiles[] queues one job per stream', async () => {
    const index: ExportRecordingIndex = {
      segmentsInWindow: async (_deviceId, profile) =>
        profile === 'main' || profile === 'low' ? [{ startMs: 0, durMs: 10_000 }] : [],
    }
    const { deps, engine, state } = await makeDeps({ index })
    const provider = buildRecordingExportProvider(deps)

    const rec = await provider.createExport({
      deviceId: 101,
      profiles: ['main', 'low'],
      fromMs: 1_000,
      toMs: 6_000,
      options: OPTIONS,
    })

    expect(engine.enqueued).toHaveLength(2)
    expect(rec.profile).toBe('main')
    const listed = await listExportsFor(state, 101)
    expect(listed.map((r) => r.profile).sort()).toEqual(['low', 'main'])
  })

  it('createExport still accepts a legacy singular profile', async () => {
    const { deps, engine } = await makeDeps()
    const provider = buildRecordingExportProvider(deps)
    const rec = await provider.createExport({
      deviceId: 101,
      profile: 'main',
      fromMs: 1_000,
      toMs: 6_000,
      options: OPTIONS,
    })
    expect(rec.profile).toBe('main')
    expect(engine.enqueued).toEqual([rec.id])
  })

  it('createExport rejects an inverted / empty range', async () => {
    const { deps } = await makeDeps()
    const provider = buildRecordingExportProvider(deps)
    await expect(
      provider.createExport({
        deviceId: 101,
        profile: 'main',
        fromMs: 6_000,
        toMs: 1_000,
        options: OPTIONS,
      }),
    ).rejects.toThrow()
  })

  it('createExport fails fast when no footage covers the range', async () => {
    const { deps, engine } = await makeDeps()
    const provider = buildRecordingExportProvider(deps)
    await expect(
      provider.createExport({
        deviceId: 101,
        profile: 'nope',
        fromMs: 1_000,
        toMs: 6_000,
        options: OPTIONS,
      }),
    ).rejects.toThrow(/footage/i)
    expect(engine.enqueued).toEqual([])
  })

  it('createExport hydrates the requested window before deciding there is no footage', async () => {
    // The live failure this pins: a `recorder` restarted at 11:04 refused a
    // 21:00→07:00 export with `no footage for 101/low`, while
    // `recording.getAvailability` — which answers from the CALENDAR, not the
    // index — listed four ranges covering the whole window. The gate read the
    // in-memory index directly; the RENDERER reads it through
    // `collectRangeSegments`, which hydrates first. Gate and renderer must ask
    // the same, hydrated question.
    const index = fakeIndex()
    const { deps, engine } = await makeDeps({ index })
    const provider = buildRecordingExportProvider(deps)

    const rec = await provider.createExport({
      deviceId: 101,
      profile: 'main',
      fromMs: 1_000,
      toMs: 6_000,
      options: OPTIONS,
    })

    expect(index.hydratedWindows).toEqual(['101:1000-6000'])
    expect(engine.enqueued).toEqual([rec.id])
  })

  it('list / get round-trip and getExport throws on unknown id', async () => {
    const { deps } = await makeDeps()
    const provider = buildRecordingExportProvider(deps)
    const rec = await provider.createExport({
      deviceId: 101,
      profile: 'main',
      fromMs: 1_000,
      toMs: 6_000,
      options: OPTIONS,
    })

    expect((await provider.listExports({ deviceId: 101 })).map((r) => r.id)).toEqual([rec.id])
    expect((await provider.listExports({ deviceId: 999 })).length).toBe(0)
    expect((await provider.getExport({ exportId: rec.id })).id).toBe(rec.id)
    await expect(provider.getExport({ exportId: 'ghost' })).rejects.toThrow()
  })

  it('cancelExport forwards to the engine and returns the record', async () => {
    const { deps, engine } = await makeDeps()
    const provider = buildRecordingExportProvider(deps)
    const rec = await provider.createExport({
      deviceId: 101,
      profile: 'main',
      fromMs: 1_000,
      toMs: 6_000,
      options: OPTIONS,
    })
    const out = await provider.cancelExport({ exportId: rec.id })
    expect(engine.cancelled).toEqual([rec.id])
    expect(out.id).toBe(rec.id)
  })

  it('deleteExport removes the file, keeps the row as deleted', async () => {
    const { deps, state, removed } = await makeDeps()
    const provider = buildRecordingExportProvider(deps)
    const rec = await provider.createExport({
      deviceId: 101,
      profile: 'main',
      fromMs: 1_000,
      toMs: 6_000,
      options: OPTIONS,
    })
    const out = await provider.deleteExport({ exportId: rec.id })
    expect(out.state).toBe('deleted')
    expect(out.fileBytes).toBeNull()
    expect(removed).toEqual([`/data/exports/101/${rec.id}.mp4`])
    // Row kept for audit.
    expect((await listExportsFor(state)).length).toBe(1)
  })

  it('getDownloadUrl returns the addon data-plane url + endpoints', async () => {
    const { deps } = await makeDeps()
    const provider = buildRecordingExportProvider(deps)
    const rec = await provider.createExport({
      deviceId: 101,
      profile: 'main',
      fromMs: 1_000,
      toMs: 6_000,
      options: OPTIONS,
    })
    const dl = await provider.getDownloadUrl({ exportId: rec.id })
    expect(dl.url).toBe(`/addon/recorder/exports/${rec.id}.mp4`)
    expect(dl.endpoints).toEqual([dl.url])
  })
})

/**
 * `readExportBytes` — the ONE byte surface a session-less fetcher can be fed
 * from. Everything here is a refusal case except the first: an export whose
 * file does not exist, is too big to move through a unary envelope, or has
 * outlived its retention must never come back as bytes.
 */
describe('recording-export provider — readExportBytes', () => {
  /** Create an export and drive it to `state`, with `fileBytes` recorded. */
  async function readyExport(
    over: Partial<RecordingExportProviderDeps> = {},
    state: ExportState = 'ready',
  ): Promise<{
    provider: ReturnType<typeof buildRecordingExportProvider>
    deps: RecordingExportProviderDeps
    exportId: string
  }> {
    const { deps } = await makeDeps(over)
    const provider = buildRecordingExportProvider(deps)
    const rec = await provider.createExport({
      deviceId: 101,
      profile: 'main',
      fromMs: 1_000,
      toMs: 6_000,
      options: { ...OPTIONS, title: 'Vialetto notte' },
    })
    await patchExport(deps.state, rec.id, { state, fileBytes: 4, progressPct: 100 })
    return { provider, deps, exportId: rec.id }
  }

  it('returns base64 bytes, content type and a suggested name for a ready export', async () => {
    const read = vi.fn(async () => Buffer.from('mp4!'))
    const { provider, exportId } = await readyExport({ readFile: read })

    const out = await provider.readExportBytes({ exportId })

    expect(Buffer.from(out.base64, 'base64').toString()).toBe('mp4!')
    expect(out.contentType).toBe('video/mp4')
    expect(out.bytes).toBe(4)
    expect(out.name).toBe('Vialetto-notte.mp4')
    expect(read).toHaveBeenCalledWith(`/data/exports/101/${exportId}.mp4`)
  })

  it.each<ExportState>([
    'queued',
    'rendering',
    'failed',
    'expired',
    'deleted',
  ])('refuses a %s export and never touches the file', async (state) => {
    const read = vi.fn(async () => Buffer.from('mp4!'))
    const { provider, exportId } = await readyExport({ readFile: read }, state)

    await expect(provider.readExportBytes({ exportId })).rejects.toThrow(/not ready/i)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses an export whose lifetime has run out, even while the row still says ready', async () => {
    const read = vi.fn(async () => Buffer.from('mp4!'))
    // `now` is 5_000 at create (expiresAt = 5_000 + maxLifeMs); the read happens
    // long after. The janitor flips `state` on its own schedule, so a live read
    // must not trust the row alone.
    let clock = 5_000
    const { provider, exportId } = await readyExport({ readFile: read, now: () => clock })
    clock = 5_000 + OPTIONS.maxLifeMs + 1

    await expect(provider.readExportBytes({ exportId })).rejects.toThrow(/expired/i)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a file above the read ceiling BEFORE reading a byte, and logs it per-camera', async () => {
    const read = vi.fn(async () => Buffer.from('mp4!'))
    const logger = makeLogger()
    const { provider, exportId } = await readyExport({
      readFile: read,
      logger,
      statBytes: async () => RECORDING_EXPORT_MAX_READ_BYTES + 1,
    })

    await expect(provider.readExportBytes({ exportId })).rejects.toThrow(/too large/i)
    // The bound is what stops the read — not a check after the bytes are in RAM.
    expect(read).not.toHaveBeenCalled()
    // A dropped branch logs, and a device line carries `tags.deviceId`.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/too large/i),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('shrinks an oversized file when shrinkToBound fits under the ceiling', async () => {
    const shrunk = Buffer.alloc(1024, 7)
    const shrinkToBound = vi.fn(async () => shrunk)
    const read = vi.fn(async () => Buffer.from('mp4!'))
    const { provider, exportId } = await readyExport({
      readFile: read,
      shrinkToBound,
      statBytes: async () => RECORDING_EXPORT_MAX_READ_BYTES + 1,
    })

    const out = await provider.readExportBytes({ exportId })
    expect(shrinkToBound).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    expect(out.bytes).toBe(shrunk.byteLength)
    expect(Buffer.from(out.base64, 'base64').equals(shrunk)).toBe(true)
  })

  it('accepts a file exactly ON the ceiling', async () => {
    const { provider, exportId } = await readyExport({
      statBytes: async () => RECORDING_EXPORT_MAX_READ_BYTES,
      readFile: async () => Buffer.from('mp4!'),
    })
    await expect(provider.readExportBytes({ exportId })).resolves.toMatchObject({
      contentType: 'video/mp4',
    })
  })

  it('refuses a vanished file rather than answering zero bytes', async () => {
    const { provider, exportId } = await readyExport({
      statBytes: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
    })
    await expect(provider.readExportBytes({ exportId })).rejects.toThrow(/file/i)
  })

  it('refuses an unknown export id', async () => {
    const { provider } = await readyExport()
    await expect(provider.readExportBytes({ exportId: 'ghost' })).rejects.toThrow()
  })
})

describe('exportFileName', () => {
  it('slugifies the operator title and keeps the mp4 extension', () => {
    expect(exportFileName({ id: 'abc', title: 'Vialetto notte 22:00→06:00' })).toBe(
      'Vialetto-notte-22-00-06-00.mp4',
    )
  })

  it('falls back to the export id when there is no usable title', () => {
    expect(exportFileName({ id: 'abc', title: undefined })).toBe('export-abc.mp4')
    expect(exportFileName({ id: 'abc', title: '///' })).toBe('export-abc.mp4')
  })

  it('bounds the name — a 200-char title must not become a 200-char filename', () => {
    const name = exportFileName({ id: 'abc', title: 'x'.repeat(200) })
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name.endsWith('.mp4')).toBe(true)
  })
})
