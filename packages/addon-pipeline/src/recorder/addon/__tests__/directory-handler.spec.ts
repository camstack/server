/**
 * The directory route. It shares a prefix with the segment bytes, so what is
 * pinned first is that it does not swallow them.
 */
import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { withDirectoryRoute, type DirectorySource } from '../directory-handler.js'
import { decodeDirectory } from '../../segment-directory.js'

const HOUR = 3_600_000
const H10 = Date.UTC(2026, 6, 29, 10)

interface Captured {
  statusCode: number
  headers: Record<string, string>
  body: Buffer
}

function fakeRes(): { res: ServerResponse; out: Captured } {
  const out: Captured = { statusCode: 0, headers: {}, body: Buffer.alloc(0) }
  const res = {
    set statusCode(v: number) {
      out.statusCode = v
    },
    get statusCode() {
      return out.statusCode
    },
    setHeader: (k: string, v: string) => {
      out.headers[k] = v
    },
    end: (b?: Buffer | string) => {
      if (b !== undefined) out.body = Buffer.isBuffer(b) ? b : Buffer.from(b)
    },
  } as unknown as ServerResponse
  return { res, out }
}

function makeHandler(
  segments: Record<number, ReadonlyArray<{ startMs: number; durMs: number; bytes: number }>>,
  opts: { profile?: string | null; scanned?: boolean; recordsRequested?: boolean } = {},
): {
  handler: ReturnType<typeof withDirectoryRoute>
  fellThrough: string[]
  requestedProfiles: Array<string | undefined>
} {
  const fellThrough: string[] = []
  const requestedProfiles: Array<string | undefined> = []
  const availability = opts.profile === undefined ? 'low' : opts.profile
  const source: DirectorySource = {
    servedProfileFor: async (_d, requested) => {
      requestedProfiles.push(requested)
      if (requested !== undefined && (opts.recordsRequested ?? false)) return requested
      return availability
    },
    segmentsOfChecked: async (_d, _p, hour) => ({
      segments: segments[hour] ?? [],
      complete: opts.scanned ?? true,
    }),
  }
  const handler = withDirectoryRoute(
    {
      source,
      now: () => Date.UTC(2026, 6, 29, 12),
    },
    (req) => {
      fellThrough.push(req.url ?? '')
    },
  )
  return { handler, fellThrough, requestedProfiles }
}

const req = (url: string): IncomingMessage => ({ url }) as IncomingMessage

describe('withDirectoryRoute', () => {
  it('leaves segment requests to the file handler', async () => {
    // The route shares a prefix with the media. Swallowing a `.m4s` would take
    // playback down with discovery.
    const h = makeHandler({})
    const { res } = fakeRes()
    await h.handler(req('/104/low/2026/07/29/10/1785276000000-8000-50000.m4s'), res)
    expect(h.fellThrough).toHaveLength(1)
  })

  it('answers the directory path from memory', async () => {
    const h = makeHandler({
      [H10]: [
        { startMs: H10, durMs: 8000, bytes: 50_000 },
        { startMs: H10 + 8000, durMs: 7989, bytes: 51_000 },
      ],
    })
    const { res, out } = fakeRes()
    await h.handler(req(`/104/directory?from=${H10}&to=${H10 + HOUR}`), res)
    expect(out.statusCode).toBe(200)
    const payload = decodeDirectory(new Uint8Array(out.body))
    expect(payload.rows).toHaveLength(2)
    expect(payload.rows[0]).toEqual({ startMs: H10, durMs: 8000, bytes: 50_000 })
    expect(h.fellThrough).toHaveLength(0)
  })

  it('clips to the window instead of returning the whole hour', async () => {
    const h = makeHandler({
      [H10]: [
        { startMs: H10, durMs: 8000, bytes: 50_000 },
        { startMs: H10 + 30 * 60_000, durMs: 8000, bytes: 50_000 },
      ],
    })
    const { res, out } = fakeRes()
    await h.handler(req(`/104/directory?from=${H10 + 20 * 60_000}&to=${H10 + HOUR}`), res)
    expect(decodeDirectory(new Uint8Array(out.body)).rows).toHaveLength(1)
  })

  it('says NOT hydrated when the window has not been looked at', async () => {
    // The Phase 0 distinction has to survive the wire, or the client renders
    // "not scanned yet" as "no footage".
    const h = makeHandler({}, { scanned: false })
    const { res, out } = fakeRes()
    await h.handler(req(`/104/directory?from=${H10}&to=${H10 + HOUR}`), res)
    expect(decodeDirectory(new Uint8Array(out.body)).hydrated).toBe(false)
  })

  it('answers a device that records nothing without pretending it looked', async () => {
    const h = makeHandler({}, { profile: null })
    const { res, out } = fakeRes()
    await h.handler(req(`/104/directory?from=${H10}&to=${H10 + HOUR}`), res)
    const payload = decodeDirectory(new Uint8Array(out.body))
    expect(payload.rows).toEqual([])
    expect(payload.hydrated).toBe(false)
  })

  it('states identity encoding', async () => {
    // The hub compressor has emptied bodies on forked routes before, and a
    // mangled directory is indistinguishable from an empty archive.
    const h = makeHandler({})
    const { res, out } = fakeRes()
    await h.handler(req(`/104/directory?from=${H10}&to=${H10 + HOUR}`), res)
    expect(out.headers['content-encoding']).toBe('identity')
    expect(out.headers['content-type']).toBe('application/octet-stream')
  })

  it('refuses a window wider than the retention it could answer for', async () => {
    // Answering it would walk the archive on the read path — the thing this
    // whole design removes.
    const h = makeHandler({})
    const { res, out } = fakeRes()
    await h.handler(req(`/104/directory?from=0&to=${400 * 86_400_000}`), res)
    expect(out.statusCode).toBe(400)
  })

  it('refuses a malformed window rather than guessing one', async () => {
    const h = makeHandler({})
    const { res, out } = fakeRes()
    await h.handler(req('/104/directory?from=abc'), res)
    expect(out.statusCode).toBe(400)
  })

  it('serves the ASKED profile when the device records it', async () => {
    const h = makeHandler(
      { [H10]: [{ startMs: H10, durMs: 8000, bytes: 50_000 }] },
      { recordsRequested: true },
    )
    const { res, out } = fakeRes()
    await h.handler(req(`/104/directory?from=${H10}&to=${H10 + HOUR}&profile=high`), res)
    expect(h.requestedProfiles).toEqual(['high'])
    expect(decodeDirectory(new Uint8Array(out.body)).profile).toBe('high')
  })

  it('attaches the finalize-captured mfra table to the rows that have one', async () => {
    const fellThrough: string[] = []
    const table = {
      trackId: 1,
      mfraOffset: 49_000,
      samples: [{ timeTicks: 0, moofOffset: 4096 }],
    }
    const handler = withDirectoryRoute(
      {
        source: {
          servedProfileFor: async () => 'low',
          segmentsOfChecked: async () => ({
            segments: [
              { startMs: H10, durMs: 8000, bytes: 50_000 },
              { startMs: H10 + 8000, durMs: 8000, bytes: 50_000 },
            ],
            complete: true,
          }),
        },
        // Only the FIRST row has a captured table — the second predates boot.
        mfraFor: (_d, _p, startMs) => (startMs === H10 ? table : undefined),
        now: () => Date.UTC(2026, 6, 29, 12),
      },
      (req) => {
        fellThrough.push(req.url ?? '')
      },
    )
    const { res, out } = fakeRes()
    await handler(req(`/104/directory?from=${H10}&to=${H10 + HOUR}`), res)
    const payload = decodeDirectory(new Uint8Array(out.body))
    expect(payload.rows[0]?.mfra).toEqual(table)
    expect(payload.rows[1]?.mfra).toBeUndefined()
  })

  it('states the FALLBACK profile when the asked one is not recorded', async () => {
    // The client's byte-range URLs are built from the profile actually served —
    // a silent fallback would point them at a tree that does not exist.
    const h = makeHandler(
      { [H10]: [{ startMs: H10, durMs: 8000, bytes: 50_000 }] },
      { recordsRequested: false },
    )
    const { res, out } = fakeRes()
    await h.handler(req(`/104/directory?from=${H10}&to=${H10 + HOUR}&profile=high`), res)
    expect(decodeDirectory(new Uint8Array(out.body)).profile).toBe('low')
  })
})
