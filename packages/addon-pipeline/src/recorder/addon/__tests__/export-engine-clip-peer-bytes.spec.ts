/**
 * The engine's CLIP branch over the addon→addon byte transport (D613).
 *
 * One rule decides every test here: the streamed path is PREFERRED, and every
 * way it can decline is NAMED. A provider that predates the transport falls
 * back to the inline read and says so with the deploy hint; a transport
 * refusal — `cross-node` above all — is a statement about the transport and
 * must never reach the operator as "this clip has no bytes".
 */
import type { ClipBytes, ExportClipSubject, ExportRecord, IScopedLogger } from '@camstack/types'
import { clipExportFailure, clipExportFailureOf } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type ClipFetchRequest,
  type ClipFetchToFileAnswer,
  type ClipFetchToFileRequest,
  ExportEngine,
} from '../export-engine.js'
import { getExportRecord, upsertExport } from '../export-store.js'
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
const OUT = '/artifacts/107/exports/clip-1.mp4'

function clipRecord(): ExportRecord {
  return {
    id: 'clip-1',
    deviceId: 107,
    profile: 'high',
    fromMs: 1_758_398_967_000,
    toMs: 1_758_398_996_000,
    subject: SUBJECT,
    options: { speed: 1, includeAudio: false, maxLifeMs: 604_800_000, deleteAfterDownload: false },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: NOW + 604_800_000,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: NOW,
    createdBy: 'operator',
    error: null,
  }
}

interface Line {
  readonly message: string
  readonly meta: Record<string, unknown>
}

interface Outcome {
  readonly rec: ExportRecord | null
  readonly streamed: ClipFetchToFileRequest[]
  readonly inline: ClipFetchRequest[]
  readonly removed: string[]
  readonly warns: Line[]
  readonly errors: Line[]
}

function collector(sink: Line[]): (message: string, ctx?: unknown) => void {
  return (message, ctx) => {
    const holder = typeof ctx === 'object' && ctx !== null ? (ctx as Record<string, unknown>) : {}
    const meta = holder['meta']
    sink.push({
      message,
      meta: typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {},
    })
  }
}

function inlineAnswer(size = 4_096): ClipBytes {
  const buf = Buffer.alloc(size, 7)
  return {
    base64: buf.toString('base64'),
    contentType: 'video/mp4',
    name: 'clip.mp4',
    bytes: buf.byteLength,
    served: 'high',
  }
}

async function run(opts: {
  toFile?: (req: ClipFetchToFileRequest) => Promise<ClipFetchToFileAnswer>
  inline?: (req: ClipFetchRequest) => Promise<ClipBytes>
}): Promise<Outcome> {
  const state = await makeExportsState()
  const record = clipRecord()
  await upsertExport(state, record)
  const streamed: ClipFetchToFileRequest[] = []
  const inline: ClipFetchRequest[] = []
  const removed: string[] = []
  const warns: Line[] = []
  const errors: Line[] = []
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: collector(warns),
    error: collector(errors),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const engine = new ExportEngine({
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    spawn: () => {
      throw new Error('a clip export must never reach ffmpeg')
    },
    logger,
    state,
    now: () => NOW,
    resolvePlaylist: async () => {
      throw new Error('a clip export must never resolve a source playlist')
    },
    ...(opts.toFile !== undefined
      ? {
          fetchClipToFile: async (req: ClipFetchToFileRequest): Promise<ClipFetchToFileAnswer> => {
            streamed.push(req)
            return await (opts.toFile ?? (async () => ({ kind: 'unsupported', detail: 'x' })))(req)
          },
        }
      : {}),
    ...(opts.inline !== undefined
      ? {
          fetchClipBytes: async (req: ClipFetchRequest): Promise<ClipBytes> => {
            inline.push(req)
            return await (opts.inline ?? (async () => inlineAnswer()))(req)
          },
          writeExportFile: async (): Promise<void> => {},
        }
      : {}),
    outPath: () => OUT,
    statBytes: async () => 4_096,
    removeFile: async (p: string): Promise<void> => void removed.push(p),
    emit: () => {},
  })
  engine.enqueue(record.id)
  await vi.waitFor(async () => {
    const row = await getExportRecord(state, record.id)
    expect(row?.state === 'ready' || row?.state === 'failed').toBe(true)
  })
  return { rec: await getExportRecord(state, record.id), streamed, inline, removed, warns, errors }
}

describe('the streamed path is preferred', () => {
  it('streams to the export path and never touches the inline read', async () => {
    const out = await run({
      toFile: async () => ({ kind: 'written', bytes: 4_096, served: 'high', durationMs: 29_000 }),
      inline: async () => inlineAnswer(),
    })
    expect(out.streamed).toHaveLength(1)
    expect(out.streamed[0]?.outPath).toBe(OUT)
    expect(out.inline).toHaveLength(0)
    expect(out.rec?.state).toBe('ready')
    expect(out.rec?.fileBytes).toBe(4_096)
  })

  it('asks for a bound far above the inline one — that is the whole point', async () => {
    // If these two numbers are ever unified, the 50 MiB refusal on a long
    // `high` twin comes back and this test is the only thing that says so.
    const out = await run({
      toFile: async () => ({ kind: 'written', bytes: 4_096, served: 'high', durationMs: null }),
    })
    expect(out.streamed[0]?.maxBytes).toBe(500 * 1024 * 1024)
  })

  it('carries the operator wake VERBATIM and the provider pin, like the inline read', async () => {
    const out = await run({
      toFile: async () => ({ kind: 'written', bytes: 4_096, served: 'high', durationMs: null }),
    })
    expect(out.streamed[0]).toMatchObject({
      deviceId: 107,
      clipId: SUBJECT.clipId,
      provider: 'provider-reolink',
      profile: 'high',
    })
    // Absent on this subject, and never invented here.
    expect(out.streamed[0]?.wake).toBeUndefined()
  })
})

describe('a provider that predates the transport', () => {
  it('falls back to the inline read and SAYS SO, with the deploy hint', async () => {
    const out = await run({
      toFile: async () => ({
        kind: 'unsupported',
        detail: 'provider-reolink has no offerClipBytes',
      }),
      inline: async () => inlineAnswer(),
    })
    expect(out.inline).toHaveLength(1)
    expect(out.rec?.state).toBe('ready')
    const said = out.warns.find((l) => l.message.includes('falling back to the inline read'))
    expect(said).toBeDefined()
    // The hint is what turns "too-large-to-transfer" from a dead end into a
    // deploy: an operator who sees that refusal after D613 is looking at a
    // stale addon.
    expect(said?.meta['hint']).toBe('camstack deploy provider-reolink')
    expect(said?.meta['inlineBound']).toBe(50 * 1024 * 1024)
  })

  it('refuses by name when there is no inline read to fall back to — never silently', async () => {
    const out = await run({
      toFile: async () => ({ kind: 'unsupported', detail: 'no offerClipBytes on this provider' }),
    })
    expect(out.rec?.state).toBe('failed')
    expect(out.rec?.error).toContain('no offerClipBytes on this provider')
    expect(out.errors.some((l) => l.message.includes('offers no byte handle'))).toBe(true)
  })
})

describe('a transport refusal is not an absence', () => {
  it('lands a cross-node refusal on the record as a fetch failure, with the reason', async () => {
    // The provider runs on an agent; its loopback ticket means nothing here.
    // That is a statement about WHERE, and the operator must be able to read
    // it — 404-shaped silence is what D611 was written about.
    const out = await run({
      toFile: async () => {
        throw new Error(
          clipExportFailure(
            'fetch-failed',
            'cross-node: this ticket was minted on node "agent-a" and this process runs on "hub"',
          ),
        )
      },
      inline: async () => inlineAnswer(),
    })
    expect(out.rec?.state).toBe('failed')
    expect(clipExportFailureOf(out.rec?.error ?? '')).toBe('fetch-failed')
    expect(out.rec?.error).toContain('agent-a')
    // And it does NOT quietly re-ask over the inline path: a transport that
    // cannot reach the provider will not reach it inline either, and a second
    // attempt would wake a battery camera twice on one authorisation (D558).
    expect(out.inline).toHaveLength(0)
    // The partial file, if any, is gone.
    expect(out.removed).toContain(OUT)
  })

  it('refuses a body over the bound as too-large, and leaves nothing behind', async () => {
    const out = await run({
      toFile: async () => {
        throw new Error(
          clipExportFailure('too-large-to-transfer', 'the body passed 524288000 bytes'),
        )
      },
    })
    expect(out.rec?.state).toBe('failed')
    expect(clipExportFailureOf(out.rec?.error ?? '')).toBe('too-large-to-transfer')
    expect(out.removed).toContain(OUT)
  })
})

describe('an implausible delivery is not a success', () => {
  it('removes the file and fails when the stream landed a box-headers MP4', async () => {
    // 262 bytes of box headers and an empty `mdat` reached a phone once. The
    // floor is applied to the STREAMED path too, and the file is removed —
    // the inline path checked before writing, this one after.
    const out = await run({
      toFile: async () => ({ kind: 'written', bytes: 262, served: 'high', durationMs: null }),
    })
    expect(out.rec?.state).toBe('failed')
    expect(out.rec?.error).toContain('262')
    expect(out.removed).toContain(OUT)
  })
})
