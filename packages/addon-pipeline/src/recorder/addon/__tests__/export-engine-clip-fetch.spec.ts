/**
 * The engine's CLIP branch — one by-handle fetch, under a bound, with a named
 * error on every failure and no ffmpeg anywhere near it (D558 § 3, § 5.1).
 */
import type { ClipBytes, ExportClipSubject, ExportRecord, IScopedLogger } from '@camstack/types'
import { clipExportFailureOf } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { CLIP_WAKE_TTL_MS, type ClipFetchRequest, ExportEngine } from '../export-engine.js'
import { getExportRecord, type RecordingExportsState, upsertExport } from '../export-store.js'
import { makeExportsState } from './exports-state-fixture.js'

const SUBJECT: ExportClipSubject = {
  kind: 'clip',
  deviceId: 107,
  provider: 'provider-reolink',
  source: 'native:reolink:onboard',
  sourceLabel: 'SD card',
  clipId: 'native:reolink:onboard:20260920_192927',
  catalogWindow: { sinceMs: 1_758_326_400_000, untilMs: 1_758_412_800_000 },
  profile: 'high',
}

const NOW = 1_758_398_999_000

function clipRecord(
  over: Partial<ExportRecord> = {},
  subject: ExportClipSubject = SUBJECT,
): ExportRecord {
  return {
    id: 'clip-1',
    deviceId: 107,
    profile: 'high',
    fromMs: 1_758_398_967_000,
    toMs: 1_758_398_996_000,
    subject,
    options: {
      speed: 1,
      includeAudio: false,
      maxLifeMs: 604_800_000,
      deleteAfterDownload: false,
    },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: NOW + 604_800_000,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: NOW,
    createdBy: 'operator',
    error: null,
    ...over,
  }
}

function makeLogger(): IScopedLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IScopedLogger
}

/** Bytes big enough to clear `EXPORT_MIN_PLAUSIBLE_BYTES`. */
function mp4Bytes(size = 4_096): Buffer {
  return Buffer.alloc(size, 7)
}

function clipAnswer(over: Partial<ClipBytes> = {}): ClipBytes {
  const buf = mp4Bytes()
  return {
    base64: buf.toString('base64'),
    contentType: 'video/mp4',
    name: 'clip.mp4',
    bytes: buf.byteLength,
    served: 'high',
    ...over,
  }
}

async function run(opts: {
  record?: ExportRecord
  fetch: (req: ClipFetchRequest) => Promise<ClipBytes>
  now?: number
}): Promise<{
  rec: ExportRecord | null
  written: Array<{ path: string; bytes: number }>
  requests: ClipFetchRequest[]
  removed: string[]
  state: RecordingExportsState
  logger: IScopedLogger
  spawns: number
}> {
  const state = await makeExportsState()
  const record = opts.record ?? clipRecord()
  await upsertExport(state, record)
  const written: Array<{ path: string; bytes: number }> = []
  const requests: ClipFetchRequest[] = []
  const removed: string[] = []
  let spawns = 0
  const logger = makeLogger()
  const engine = new ExportEngine({
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    spawn: () => {
      spawns += 1
      throw new Error('a clip export must never reach ffmpeg')
    },
    logger,
    state,
    now: () => opts.now ?? NOW,
    resolvePlaylist: async () => {
      throw new Error('a clip export must never resolve a source playlist')
    },
    fetchClipBytes: async (req) => {
      requests.push(req)
      return await opts.fetch(req)
    },
    writeExportFile: async (path, bytes) => void written.push({ path, bytes: bytes.byteLength }),
    outPath: (rec) => `/artifacts/${rec.deviceId}/exports/${rec.id}.mp4`,
    statBytes: async () => 4_096,
    removeFile: async (p) => void removed.push(p),
    emit: () => {},
  })
  engine.enqueue(record.id)
  await vi.waitFor(async () => {
    const row = await getExportRecord(state, record.id)
    expect(row?.state === 'ready' || row?.state === 'failed').toBe(true)
  })
  return {
    rec: await getExportRecord(state, record.id),
    written,
    requests,
    removed,
    state,
    logger,
    spawns,
  }
}

describe('export engine — the clip branch', () => {
  it('fetches ONCE, by handle, and lands the bytes at the export path', async () => {
    const out = await run({ fetch: async () => clipAnswer() })
    expect(out.requests).toHaveLength(1)
    expect(out.requests[0]).toMatchObject({
      deviceId: 107,
      clipId: SUBJECT.clipId,
      profile: 'high',
    })
    expect(out.written).toEqual([{ path: '/artifacts/107/exports/clip-1.mp4', bytes: 4_096 }])
    expect(out.rec?.state).toBe('ready')
    expect(out.rec?.fileBytes).toBe(4_096)
    expect(out.spawns).toBe(0)
  })

  it('passes the operator wake through verbatim, and never invents one', async () => {
    const withWake = clipRecord({}, { ...SUBJECT, wake: 'authorised' })
    const out = await run({ record: withWake, fetch: async () => clipAnswer() })
    expect(out.requests[0]?.wake).toBe('authorised')

    const plain = await run({ fetch: async () => clipAnswer() })
    expect(plain.requests[0]?.wake).toBeUndefined()
  })

  it('never publishes a fabricated progress fraction', async () => {
    // D558 § 5.1: the whole job is ~4–6 s and only two of its phases have a
    // real denominator. A ramp is a claim, and `progressPct` is nullable
    // precisely so the honest answer is representable.
    const out = await run({ fetch: async () => clipAnswer() })
    expect(out.rec?.progressPct).toBe(100)
    const mid = await run({
      fetch: async () => {
        throw new Error('camera said no')
      },
    })
    expect(mid.rec?.progressPct).toBeNull()
  })

  it('refuses a clip above the transfer bound — never a truncated MP4', async () => {
    const out = await run({
      fetch: async () => {
        throw new Error('videoclips: clip is too large to read inline (81788928 > 52428800 bytes)')
      },
    })
    expect(out.rec?.state).toBe('failed')
    expect(clipExportFailureOf(out.rec?.error ?? null)).toBe('too-large-to-transfer')
    expect(out.written).toEqual([])
  })

  it('keeps a producer refusal that already speaks the vocabulary', async () => {
    const out = await run({
      fetch: async () => {
        throw new Error('sleeping: 106 is a standalone battery camera and nobody authorised a wake')
      },
    })
    expect(clipExportFailureOf(out.rec?.error ?? null)).toBe('sleeping')
    expect(out.rec?.error).toContain('standalone battery camera')
  })

  it('names an unclassified producer failure, carrying its words verbatim', async () => {
    const out = await run({
      fetch: async () => {
        throw new Error('ECONNRESET talking to 192.168.10.42')
      },
    })
    expect(clipExportFailureOf(out.rec?.error ?? null)).toBe('fetch-failed')
    expect(out.rec?.error).toContain('ECONNRESET talking to 192.168.10.42')
  })

  it('refuses a file too small to hold a frame, as the render path already does', async () => {
    const tiny = Buffer.alloc(262, 1)
    const out = await run({
      fetch: async () => clipAnswer({ base64: tiny.toString('base64'), bytes: tiny.byteLength }),
    })
    expect(out.rec?.state).toBe('failed')
    expect(clipExportFailureOf(out.rec?.error ?? null)).toBe('fetch-failed')
    expect(out.rec?.error).toContain('262')
  })

  it('records the twin that was SERVED when it differs from the one projected', async () => {
    // 17 of 546 clips on 592 have no main twin. The row must say `low` a week
    // later, or the operator believes he kept the main copy.
    const out = await run({ fetch: async () => clipAnswer({ served: 'low' }) })
    expect(out.rec?.state).toBe('ready')
    expect(out.rec?.profile).toBe('low')
  })

  it('logs a duration that disagrees with the catalog row, and rewrites neither number', async () => {
    // D558 § 5.4.1: the row may be stale (`catalogAsOf`). Silently rewriting
    // either number would make the disagreement unobservable.
    const out = await run({ fetch: async () => clipAnswer({ durationMs: 12_000 }) })
    expect(out.rec?.fromMs).toBe(1_758_398_967_000)
    expect(out.rec?.toMs).toBe(1_758_398_996_000)
    expect(out.rec?.state).toBe('ready')
    const warn = vi.mocked(out.logger.warn)
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('duration'))).toBe(true)
  })

  it('a job that outlived its wake FAILS rather than waking the camera again', async () => {
    // One authorised yes is ONE wake (D558 § 5.2 rule 3). A clip export that
    // sat behind two long renders, or across a restart, must not spend the
    // same yes an hour later.
    const stale = clipRecord(
      { createdAt: NOW - CLIP_WAKE_TTL_MS - 1 },
      { ...SUBJECT, wake: 'authorised' },
    )
    const out = await run({
      record: stale,
      fetch: async () => {
        throw new Error('the fetch must not have been attempted')
      },
    })
    expect(out.requests).toEqual([])
    expect(out.rec?.state).toBe('failed')
    expect(clipExportFailureOf(out.rec?.error ?? null)).toBe('wake-expired')
  })

  it('an old job with NO wake still runs — there is no authorisation to spend', async () => {
    const old = clipRecord({ createdAt: NOW - CLIP_WAKE_TTL_MS - 1 })
    const out = await run({ record: old, fetch: async () => clipAnswer() })
    expect(out.requests).toHaveLength(1)
    expect(out.rec?.state).toBe('ready')
  })

  it('sends an ANALYTICS clip down the RENDER path — never the by-handle fetch', async () => {
    // One subject, TWO producers, chosen by the source namespace exactly as
    // `getClipPlayback` already dispatches — never by a flag a caller sets
    // (D558 § 5.4.3). An analytics clip is a window over footage WE wrote: it
    // can span holes, and the source playlist plus `export-dense-map` are the
    // machinery that handles them. Asking this recorder for its own clip's
    // bytes by handle would be asking it to fetch from itself.
    const state = await makeExportsState()
    const analytics: ExportClipSubject = {
      ...SUBJECT,
      provider: 'recorder',
      source: 'analytics',
      clipId: 'analytics:1758398967000:1758398996000:visit',
    }
    await upsertExport(state, clipRecord({ id: 'clip-analytics' }, analytics))
    let playlistAsked = 0
    let fetched = 0
    const engine = new ExportEngine({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn: () => {
        throw new Error('spawn')
      },
      logger: makeLogger(),
      state,
      now: () => NOW,
      resolvePlaylist: async () => {
        playlistAsked += 1
        return null
      },
      fetchClipBytes: async () => {
        fetched += 1
        return clipAnswer()
      },
      writeExportFile: async () => {},
      outPath: (rec) => `/artifacts/${rec.deviceId}/exports/${rec.id}.mp4`,
      statBytes: async () => 0,
      removeFile: async () => {},
      emit: () => {},
    })
    engine.enqueue('clip-analytics')
    await vi.waitFor(async () => {
      const row = await getExportRecord(state, 'clip-analytics')
      expect(row?.state).toBe('failed')
    })
    expect(playlistAsked).toBe(1)
    expect(fetched).toBe(0)
  })

  it('never retries a failed clip export on its own', async () => {
    let calls = 0
    const out = await run({
      fetch: async () => {
        calls += 1
        throw new Error('camera-refused: busy')
      },
    })
    expect(calls).toBe(1)
    expect(out.rec?.state).toBe('failed')
  })
})
