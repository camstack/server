/**
 * Unit tests for createSnapshotMediaHandler — the pure handler factory that
 * serves per-device snapshot JPEGs over the addon HTTP data-plane at
 * `/addon/snapshot/media/<deviceId>.jpg`.
 *
 * Covers:
 *  - GET /<id>.jpg with a cached frame → 200, image/jpeg, ETag + short max-age
 *  - conditional GET (If-None-Match == etag) → 304, zero body
 *  - GET for a device with no frame (getMedia → null) → 404
 *  - malformed device id → 404 (never reaches getMedia)
 *  - non-GET/HEAD method → 405
 *  - HEAD with a cached frame → 200, headers, no body
 *  - query parsing: ?streamId=…&force=1 threads into getMedia
 *  - Cache-Control max-age mirrors the device's effective maxAgeS
 */
import { describe, it, expect, vi } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { OutgoingHttpHeader } from 'node:http'
import { Socket } from 'node:net'
import {
  createSnapshotMediaHandler,
  parseSnapshotMediaRequest,
  snapshotEtag,
  type SnapshotMediaRequest,
} from '../snapshot-media-handler.js'
import type { SnapshotMedia } from '../snapshot-media-handler.js'

// ── Test doubles ─────────────────────────────────────────────────────

function makeReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = url
  for (const [k, v] of Object.entries(headers)) req.headers[k] = v
  return req
}

interface RecordedResponse {
  statusCode: number
  headers: Record<string, OutgoingHttpHeader>
  body: Buffer | null
}

function makeRes(): { res: ServerResponse; recorded: RecordedResponse } {
  const dummyReq = makeReq('GET', '/')
  const recorded: RecordedResponse = { statusCode: 200, headers: {}, body: null }
  const res = new ServerResponse(dummyReq)
  res.assignSocket(new Socket())
  // Test-boundary cast: the recorder only needs the `(code, headers)` overload;
  // the full `writeHead` union (with a `statusMessage` positional) is irrelevant
  // to these unit tests. Mirrors the event-media handler spec's response double.
  res.writeHead = ((code: number, hdrs?: Record<string, string | number | string[]>) => {
    recorded.statusCode = code
    if (hdrs) for (const [k, v] of Object.entries(hdrs)) recorded.headers[k] = v
    return res
  }) as typeof res.writeHead
  const chunks: Buffer[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.end = (chunk?: any): ServerResponse => {
    if (chunk instanceof Buffer) chunks.push(chunk)
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    recorded.body = chunks.length > 0 ? Buffer.concat(chunks) : null
    return res
  }
  return { res, recorded }
}

function makeMedia(overrides: Partial<SnapshotMedia> = {}): SnapshotMedia {
  return {
    bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
    contentType: 'image/jpeg',
    capturedAt: 1_700_000_000_000,
    maxAgeS: 10,
    ...overrides,
  }
}

// ── parseSnapshotMediaRequest ─────────────────────────────────────────

describe('parseSnapshotMediaRequest', () => {
  it('parses a bare numeric id', () => {
    expect(parseSnapshotMediaRequest('/7')).toEqual({
      deviceId: 7,
      streamId: undefined,
      force: false,
    })
  })

  it('strips a .jpg extension', () => {
    expect(parseSnapshotMediaRequest('/42.jpg')?.deviceId).toBe(42)
  })

  it('strips a .jpeg extension (case-insensitive)', () => {
    expect(parseSnapshotMediaRequest('/42.JPEG')?.deviceId).toBe(42)
  })

  it('reads streamId + force from the query', () => {
    expect(parseSnapshotMediaRequest('/7.jpg?streamId=high&force=1')).toEqual({
      deviceId: 7,
      streamId: 'high',
      force: true,
    })
  })

  it('treats force=true as forced', () => {
    expect(parseSnapshotMediaRequest('/7?force=true')?.force).toBe(true)
  })

  it('ignores an empty streamId', () => {
    expect(parseSnapshotMediaRequest('/7?streamId=')?.streamId).toBeUndefined()
  })

  it('returns null for a non-numeric id', () => {
    expect(parseSnapshotMediaRequest('/abc.jpg')).toBeNull()
  })

  it('returns null for a nested path', () => {
    expect(parseSnapshotMediaRequest('/7/extra.jpg')).toBeNull()
  })

  it('returns null for an empty path', () => {
    expect(parseSnapshotMediaRequest('/')).toBeNull()
  })
})

// ── createSnapshotMediaHandler ────────────────────────────────────────

describe('createSnapshotMediaHandler', () => {
  it('returns 200 image/jpeg with ETag + private short max-age for a cached frame', async () => {
    const handler = createSnapshotMediaHandler({
      getMedia: async (deviceId) => (deviceId === 7 ? makeMedia() : null),
    })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg'), res)

    expect(recorded.statusCode).toBe(200)
    expect(recorded.headers['content-type']).toBe('image/jpeg')
    expect(recorded.headers['etag']).toBe('"7-1700000000000"')
    expect(String(recorded.headers['cache-control'])).toContain('private')
    expect(String(recorded.headers['cache-control'])).toContain('max-age=10')
    expect(recorded.body?.length).toBe(5)
  })

  it('mirrors the device maxAgeS into Cache-Control (battery cam)', async () => {
    const handler = createSnapshotMediaHandler({
      getMedia: async () => makeMedia({ maxAgeS: 3600 }),
    })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/9.jpg'), res)
    expect(String(recorded.headers['cache-control'])).toContain('max-age=3600')
  })

  it('returns 304 with no body when If-None-Match matches the ETag', async () => {
    const handler = createSnapshotMediaHandler({ getMedia: async () => makeMedia() })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg', { 'if-none-match': '"7-1700000000000"' }), res)

    expect(recorded.statusCode).toBe(304)
    expect(recorded.body).toBeNull()
    expect(recorded.headers['etag']).toBe('"7-1700000000000"')
  })

  it('returns 404 when the device has no frame', async () => {
    const handler = createSnapshotMediaHandler({ getMedia: async () => null })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg'), res)
    expect(recorded.statusCode).toBe(404)
  })

  it('returns 404 for a malformed id without calling getMedia', async () => {
    const getMedia = vi.fn(async () => makeMedia())
    const handler = createSnapshotMediaHandler({ getMedia })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/nope.jpg'), res)
    expect(recorded.statusCode).toBe(404)
    expect(getMedia).not.toHaveBeenCalled()
  })

  it('returns 405 for a non-GET/HEAD method', async () => {
    const handler = createSnapshotMediaHandler({ getMedia: async () => makeMedia() })
    const { res, recorded } = makeRes()
    await handler(makeReq('POST', '/7.jpg'), res)
    expect(recorded.statusCode).toBe(405)
    expect(recorded.headers['allow']).toBe('GET, HEAD')
  })

  it('serves a HEAD request with headers but no body', async () => {
    const handler = createSnapshotMediaHandler({ getMedia: async () => makeMedia() })
    const { res, recorded } = makeRes()
    await handler(makeReq('HEAD', '/7.jpg'), res)
    expect(recorded.statusCode).toBe(200)
    expect(recorded.headers['content-type']).toBe('image/jpeg')
    expect(recorded.body).toBeNull()
  })

  it('threads streamId + force through to getMedia', async () => {
    const getMedia = vi.fn(async () => makeMedia())
    const handler = createSnapshotMediaHandler({ getMedia })
    const { res } = makeRes()
    await handler(makeReq('GET', '/7.jpg?streamId=mid&force=1'), res)
    expect(getMedia).toHaveBeenCalledWith(7, 'mid', true, undefined)
  })

  it('returns 500 when getMedia throws', async () => {
    const handler = createSnapshotMediaHandler({
      getMedia: async () => {
        throw new Error('boom')
      },
    })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg'), res)
    expect(recorded.statusCode).toBe(500)
  })
})

/**
 * `?w=` — the card thumbnail lever.
 *
 * Cards render into 180–390 px tiles and were being served the full 4K frame:
 * measured 756 KB average across twelve cameras, ~9 MB per tab load, plus
 * ~100 Mpx of JPEG decode on the client's main thread.
 *
 * The width is SNAPPED to a small ladder rather than honoured verbatim. A free
 * integer is an unbounded cache key and an unbounded number of ffmpeg runs —
 * one request per pixel width would let any caller mint work and memory.
 */
describe('requested width', () => {
  it('is absent when not asked for', () => {
    expect(parseSnapshotMediaRequest('/101.jpg')?.width).toBeUndefined()
  })

  it('snaps up to the next rung of the ladder', () => {
    // A 350 px tile gets the 480 rung: never smaller than asked, so the image
    // is not upscaled by the client.
    expect(parseSnapshotMediaRequest('/101.jpg?w=350')?.width).toBe(480)
    expect(parseSnapshotMediaRequest('/101.jpg?w=160')?.width).toBe(160)
    expect(parseSnapshotMediaRequest('/101.jpg?w=161')?.width).toBe(240)
  })

  it('collapses a burst of near-identical widths onto one variant', () => {
    // Twelve tiles measured at slightly different widths must not produce
    // twelve cache entries and twelve ffmpeg runs.
    const widths = [181, 190, 205, 232, 240].map(
      (w) => parseSnapshotMediaRequest(`/101.jpg?w=${String(w)}`)?.width,
    )
    expect(new Set(widths).size).toBe(1)
  })

  it('clamps above the ladder to the largest rung rather than serving 4K', () => {
    expect(parseSnapshotMediaRequest('/101.jpg?w=99999')?.width).toBe(960)
  })

  it('ignores a width that is not a positive integer', () => {
    for (const raw of ['0', '-5', 'abc', '', '1.5']) {
      expect(parseSnapshotMediaRequest(`/101.jpg?w=${raw}`)?.width).toBeUndefined()
    }
  })

  it('composes with the other params', () => {
    const parsed = parseSnapshotMediaRequest('/101.jpg?streamId=low&force=1&w=320')
    expect(parsed).toEqual({ deviceId: 101, streamId: 'low', force: true, width: 320 })
  })
})

describe('etag identifies the VARIANT', () => {
  const req = (over: Partial<SnapshotMediaRequest> = {}): SnapshotMediaRequest => ({
    deviceId: 101,
    streamId: undefined,
    force: false,
    width: undefined,
    ...over,
  })

  it('keeps the plain form for a plain request', () => {
    // `getSnapshotOverview` advertises this identity; a resize must not change
    // what an untouched frame is called.
    expect(snapshotEtag(req(), 1000)).toBe('"101-1000"')
  })

  it('differs per width', () => {
    // Without this a client that fetched ?w=320 gets a 304 for ?w=960 and
    // renders the small image at full size.
    expect(snapshotEtag(req({ width: 320 }), 1000)).not.toBe(
      snapshotEtag(req({ width: 960 }), 1000),
    )
  })

  it('differs per stream', () => {
    expect(snapshotEtag(req({ streamId: 'low' }), 1000)).not.toBe(
      snapshotEtag(req({ streamId: 'high' }), 1000),
    )
  })

  it('differs when camera state changes over the same cached capture', () => {
    expect(snapshotEtag(req(), 1000)).not.toBe(
      snapshotEtag({ ...req(), variantKey: 'sleeping' }, 1000),
    )
  })

  it('still changes when the frame is recaptured', () => {
    expect(snapshotEtag(req({ width: 320 }), 1000)).not.toBe(
      snapshotEtag(req({ width: 320 }), 2000),
    )
  })
})

// ── Defect fixes: the cheap 304, and the ETag a failed resize poisoned ──

describe('conditional GET is answered BEFORE the capture ladder runs', () => {
  it('a matching If-None-Match against the fresh cached frame never calls getMedia', async () => {
    // The whole point: `getMedia` runs the coalesced ladder AND the resize, so
    // comparing ETags after it means a 304 costs a full capture. Only the body
    // bytes were being saved.
    const getMedia = vi.fn(async () => makeMedia())
    const peekFresh = vi.fn(async () => ({ capturedAt: 1_700_000_000_000, maxAgeS: 10 }))
    const handler = createSnapshotMediaHandler({ getMedia, peekFresh })
    const etag = snapshotEtag({ deviceId: 7, streamId: undefined, width: 320 }, 1_700_000_000_000)
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg?w=320', { 'if-none-match': etag }), res)

    expect(recorded.statusCode).toBe(304)
    expect(recorded.body).toBeNull()
    expect(getMedia).not.toHaveBeenCalled()
    expect(peekFresh).toHaveBeenCalledWith(7, undefined)
  })

  it('a NON-matching If-None-Match still runs the ladder', async () => {
    const getMedia = vi.fn(async () => makeMedia())
    const peekFresh = vi.fn(async () => ({ capturedAt: 1_700_000_000_000, maxAgeS: 10 }))
    const handler = createSnapshotMediaHandler({ getMedia, peekFresh })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg?w=320', { 'if-none-match': '"7-1-w320"' }), res)

    expect(recorded.statusCode).toBe(200)
    expect(getMedia).toHaveBeenCalledTimes(1)
  })

  it('a STALE cached frame is never short-circuited — the tile must be allowed to move', async () => {
    // peekFresh returns null when the entry is past its max-age. Answering 304
    // there would pin the tile to the old frame forever, which is the exact
    // complaint this whole change exists to fix.
    const getMedia = vi.fn(async () => makeMedia({ capturedAt: 2_000_000_000_000 }))
    const peekFresh = vi.fn(async () => null)
    const handler = createSnapshotMediaHandler({ getMedia, peekFresh })
    const etag = snapshotEtag({ deviceId: 7, streamId: undefined, width: 320 }, 1_700_000_000_000)
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg?w=320', { 'if-none-match': etag }), res)

    expect(recorded.statusCode).toBe(200)
    expect(getMedia).toHaveBeenCalledTimes(1)
  })

  it('force=1 is never short-circuited — an operator refresh must reach the camera', async () => {
    // A real forced capture lands a NEW frame, so the response is a 200 with
    // the new tag. What is being asserted is that the ladder ran at all: the
    // peek must not answer 304 off a frame the operator explicitly rejected.
    const getMedia = vi.fn(async () => makeMedia({ capturedAt: 1_700_000_009_999 }))
    const peekFresh = vi.fn(async () => ({ capturedAt: 1_700_000_000_000, maxAgeS: 10 }))
    const handler = createSnapshotMediaHandler({ getMedia, peekFresh })
    const etag = snapshotEtag(
      { deviceId: 7, streamId: undefined, width: undefined },
      1_700_000_000_000,
    )
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg?force=1', { 'if-none-match': etag }), res)

    expect(getMedia).toHaveBeenCalledTimes(1)
    expect(recorded.statusCode).toBe(200)
  })

  it('without a peekFresh dep the handler behaves exactly as before (ladder, then compare)', async () => {
    const getMedia = vi.fn(async () => makeMedia())
    const handler = createSnapshotMediaHandler({ getMedia })
    const etag = snapshotEtag(
      { deviceId: 7, streamId: undefined, width: undefined },
      1_700_000_000_000,
    )
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg', { 'if-none-match': etag }), res)

    expect(recorded.statusCode).toBe(304)
    expect(getMedia).toHaveBeenCalledTimes(1)
  })
})

describe('the ETag describes the bytes actually served, not the width requested', () => {
  it('a resize failure that serves the FULL frame does not mint a -w<width> ETag', async () => {
    // The poisoning: the full frame goes out under `"7-<ts>-w320"`. A later
    // SUCCESSFUL resize of the same capture mints the identical ETag with
    // different bytes, so a client holding the megabyte gets a 304 and keeps it.
    const getMedia = vi.fn(async () => makeMedia({ servedWidth: undefined }))
    const handler = createSnapshotMediaHandler({ getMedia })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg?w=320', {}), res)

    expect(recorded.statusCode).toBe(200)
    expect(recorded.headers['etag']).toBe('"7-1700000000000"')
    expect(recorded.headers['etag']).not.toContain('w320')
  })

  it('a successful resize still carries the width', async () => {
    const getMedia = vi.fn(async () => makeMedia({ servedWidth: 320 }))
    const handler = createSnapshotMediaHandler({ getMedia })
    const { res, recorded } = makeRes()
    await handler(makeReq('GET', '/7.jpg?w=320', {}), res)

    expect(recorded.headers['etag']).toBe('"7-1700000000000-w320"')
  })

  it('the two cases are distinguishable — same capture, different bytes, different ETag', async () => {
    const full = snapshotEtag({ deviceId: 7, streamId: undefined, width: undefined }, 1000)
    const resized = snapshotEtag({ deviceId: 7, streamId: undefined, width: 320 }, 1000)
    expect(full).not.toBe(resized)
  })
})
