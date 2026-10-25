/**
 * Unit tests for createEventMediaHandler — the pure handler factory that
 * serves event thumbnail JPEGs over the addon HTTP data-plane.
 *
 * Covers (D482 plane paths: `/m/<mediaId>` — one media row):
 *  - GET /m/<mediaId> with known row → 200, image/jpeg, immutable cache, etag header
 *  - GET /m/<mediaId> with If-None-Match == etag → 304
 *  - GET /m/<mediaId> for an id getMedia cannot resolve (→ null) → 404
 *  - Non-GET/HEAD method → 405
 *  - HEAD /m/<mediaId> with known row → 200, no body
 */
import { describe, it, expect } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { OutgoingHttpHeader } from 'node:http'
import { Socket } from 'node:net'
import {
  createEventMediaHandler,
  parseEventMediaVariant,
  parseEventMediaKind,
} from '../event-media-handler.js'
import type { EventMedia, EventMediaVariant } from '../event-media-handler.js'

// ── Test doubles ─────────────────────────────────────────────────────

/**
 * Build a minimal IncomingMessage suitable for handler tests.
 * We construct a real IncomingMessage over a plain Socket so the
 * handler signature is satisfied without casts.
 */
function makeReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = url
  for (const [k, v] of Object.entries(headers)) {
    req.headers[k] = v
  }
  return req
}

interface RecordedResponse {
  statusCode: number
  headers: Record<string, OutgoingHttpHeader>
  body: Buffer | null
}

/**
 * Build a ServerResponse double that records writeHead + end calls.
 * We construct a real ServerResponse (it needs an IncomingMessage for
 * the server side) but fully intercept write/end to capture output
 * without touching the fake socket (avoids ERR_SOCKET_CLOSED exceptions).
 */
function makeRes(): { res: ServerResponse; recorded: RecordedResponse } {
  // A dummy IncomingMessage for the ServerResponse constructor.
  const dummyReq = makeReq('GET', '/')
  const recorded: RecordedResponse = { statusCode: 200, headers: {}, body: null }

  const res = new ServerResponse(dummyReq)

  // Assign a no-op socket so the response object doesn't throw on
  // construction, but do NOT call the real socket write methods.
  const fakeSocket = new Socket()
  res.assignSocket(fakeSocket)

  // Intercept writeHead to capture status + headers without forwarding to socket.
  const writeHead: ServerResponse['writeHead'] = (statusCode, ...rest) => {
    recorded.statusCode = statusCode
    const hdrs = typeof rest[0] === 'string' ? rest[1] : rest[0]
    if (hdrs !== undefined && typeof hdrs === 'object' && hdrs !== null && !Array.isArray(hdrs)) {
      const headerRecord: Record<string, OutgoingHttpHeader> = { ...hdrs }
      for (const [k, v] of Object.entries(headerRecord)) {
        recorded.headers[k] = v
      }
    }
    return res
  }
  res.writeHead = writeHead

  const chunks: Buffer[] = []

  // Intercept end to capture body without writing to the socket.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.end = (chunk?: any): ServerResponse => {
    if (chunk instanceof Buffer) {
      chunks.push(chunk)
      recorded.body = Buffer.concat(chunks)
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk))
      recorded.body = Buffer.concat(chunks)
    } else {
      recorded.body = chunks.length > 0 ? Buffer.concat(chunks) : null
    }
    return res
  }

  return { res, recorded }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** A resolved media row (D482) — addressed by its OWN id, never a composite
 *  key. `kind` defaults to `'crop'`, which nothing here asserts on. */
function makeMedia(
  mediaId: number,
  bytes: Uint8Array,
  extra: Partial<Pick<EventMedia, 'kind' | 'variant' | 'deviceId'>> = {},
): EventMedia {
  return {
    mediaId,
    kind: extra.kind ?? 'crop',
    bytes,
    ...(extra.variant !== undefined ? { variant: extra.variant } : {}),
    ...(extra.deviceId !== undefined ? { deviceId: extra.deviceId } : {}),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('createEventMediaHandler — a share link sees only its own devices', () => {
  // The hub admits a share-link token on this plane and sets
  // `x-camstack-share-devices` itself (never the client). The plane MUST
  // refuse a blob whose device is outside that list — a share of two cameras
  // must not become a window on every camera's event media.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
  function handlerFor(deviceId: number | null) {
    return createEventMediaHandler({
      getMedia: async () => makeMedia(1, jpeg, { deviceId: deviceId ?? undefined }),
    })
  }

  it('serves a device inside the scope, refuses one outside it, and refuses an unknown owner', async () => {
    const inside = makeRes()
    await handlerFor(101)(
      makeReq('GET', '/m/1', { 'x-camstack-share-devices': '101,102' }),
      inside.res,
    )
    expect(inside.recorded.statusCode).toBe(200)
    const outside = makeRes()
    await handlerFor(640)(
      makeReq('GET', '/m/1', { 'x-camstack-share-devices': '101,102' }),
      outside.res,
    )
    expect(outside.recorded.statusCode).toBe(403)
    expect(outside.recorded.body).toBeNull()
    const unknown = makeRes()
    await handlerFor(null)(
      makeReq('GET', '/m/1', { 'x-camstack-share-devices': '101,102' }),
      unknown.res,
    )
    expect(unknown.recorded.statusCode).toBe(403)
  })

  it('without the header nothing changes — a session is not a share', async () => {
    const r = makeRes()
    await handlerFor(640)(makeReq('GET', '/m/1'), r.res)
    expect(r.recorded.statusCode).toBe(200)
  })
})

describe('createEventMediaHandler', () => {
  describe('GET /m/<mediaId> — known row', () => {
    it('returns 200 with image/jpeg content-type', async () => {
      const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00])
      const handler = createEventMediaHandler({
        getMedia: async (address) =>
          address.kind === 'row' && address.mediaId === 1
            ? makeMedia(1, jpegBytes, { kind: 'thumbnail' })
            : null,
      })

      const req = makeReq('GET', '/m/1')
      const { res, recorded } = makeRes()

      await handler(req, res)

      expect(recorded.statusCode).toBe(200)
      expect(recorded.headers['content-type']).toBe('image/jpeg')
    })

    it('returns cache-control with immutable', async () => {
      const jpegBytes = Uint8Array.from([0xff, 0xd8])
      const handler = createEventMediaHandler({
        getMedia: async (address) =>
          address.kind === 'row' && address.mediaId === 1 ? makeMedia(1, jpegBytes) : null,
      })

      const req = makeReq('GET', '/m/1')
      const { res, recorded } = makeRes()
      await handler(req, res)

      const cc = String(recorded.headers['cache-control'] ?? '')
      expect(cc).toContain('immutable')
    })

    it('returns an etag header built from the row id (D482)', async () => {
      const jpegBytes = Uint8Array.from([0xff, 0xd8])
      const handler = createEventMediaHandler({
        getMedia: async () => makeMedia(42, jpegBytes),
      })

      const req = makeReq('GET', '/m/42')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.headers['etag']).toBe('"42"')
    })

    it('reports media resolution time for client-side correlation', async () => {
      const handler = createEventMediaHandler({
        getMedia: async () => makeMedia(7, Uint8Array.from([0xff, 0xd8])),
      })
      const { res, recorded } = makeRes()
      await handler(makeReq('GET', '/m/7'), res)

      expect(String(recorded.headers['server-timing'])).toMatch(/^resolve;dur=\d+\.\d$/)
    })
  })

  describe('GET /m/<mediaId> — conditional request (ETag)', () => {
    it('returns 304 when If-None-Match matches the etag, with no body', async () => {
      const jpegBytes = Uint8Array.from([0xff, 0xd8])
      const handler = createEventMediaHandler({
        getMedia: async () => makeMedia(9, jpegBytes),
      })

      const etag = '"9"'
      const req = makeReq('GET', '/m/9', { 'if-none-match': etag })
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(304)
      expect(recorded.body).toBeNull()
    })
  })

  describe('GET /m/<mediaId> — id getMedia cannot resolve', () => {
    it('returns 404 when getMedia returns null for an otherwise well-formed address', async () => {
      const handler = createEventMediaHandler({
        getMedia: async () => null,
      })

      const req = makeReq('GET', '/m/404')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(404)
    })
  })

  describe('GET with empty path', () => {
    it('returns 404 for a path that names no address form at all', async () => {
      const handler = createEventMediaHandler({
        getMedia: async () => makeMedia(1, Uint8Array.from([0xff])),
      })

      const req = makeReq('GET', '/')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(404)
    })
  })

  describe('non-GET/HEAD method', () => {
    it('returns 405 for POST', async () => {
      const handler = createEventMediaHandler({
        getMedia: async () => makeMedia(1, Uint8Array.from([0xff])),
      })

      const req = makeReq('POST', '/m/1')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(405)
    })
  })

  describe('HEAD /m/<mediaId> — known row', () => {
    it('returns 200 with headers but no body', async () => {
      const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff])
      const handler = createEventMediaHandler({
        getMedia: async () => makeMedia(5, jpegBytes),
      })

      const req = makeReq('HEAD', '/m/5')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(200)
      expect(recorded.headers['content-type']).toBe('image/jpeg')
      // Body must be absent for HEAD responses
      expect(recorded.body).toBeNull()
    })
  })

  describe('getMedia throws', () => {
    it('returns 500 with a fixed opaque body (not the thrown message)', async () => {
      const thrownMessage = 'storage connection lost'
      const handler = createEventMediaHandler({
        getMedia: async () => {
          throw new Error(thrownMessage)
        },
      })

      const req = makeReq('GET', '/m/1')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(500)
      expect(recorded.body?.toString()).toBe('Internal server error')
      expect(recorded.body?.toString()).not.toContain(thrownMessage)
    })
  })

  describe('?variant=thumb', () => {
    it('parseEventMediaVariant returns null when no variant requested', () => {
      expect(parseEventMediaVariant('')).toBeNull()
      expect(parseEventMediaVariant('foo=bar')).toBeNull()
    })

    it('parseEventMediaVariant recognises variant=thumb with default size', () => {
      expect(parseEventMediaVariant('variant=thumb')).toEqual({ kind: 'thumb', size: 160 })
    })

    it('parseEventMediaVariant recognises square=1 and clamps size', () => {
      expect(parseEventMediaVariant('square=1&size=9999')).toEqual({ kind: 'thumb', size: 320 })
      expect(parseEventMediaVariant('variant=thumb&w=1')).toEqual({ kind: 'thumb', size: 64 })
      expect(parseEventMediaVariant('variant=thumb&size=144')).toEqual({ kind: 'thumb', size: 144 })
    })

    it('passes the parsed variant to getMedia', async () => {
      let seen: EventMediaVariant | undefined = undefined
      const handler = createEventMediaHandler({
        getMedia: async (_address, variant) => {
          seen = variant
          return makeMedia(144, Uint8Array.from([0xff, 0xd8]), { variant })
        },
      })
      const req = makeReq('GET', '/m/1?variant=thumb&size=144')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(200)
      expect(seen).toEqual({ kind: 'thumb', size: 144 })
    })

    it('uses the variant-distinct ETag (no collision with the full frame) — built from (mediaId, variant), D482', async () => {
      const handler = createEventMediaHandler({
        getMedia: async (_address, variant) =>
          variant
            ? makeMedia(1000, Uint8Array.from([0xff, 0xd8]), { variant })
            : makeMedia(1000, Uint8Array.from([0xff, 0xd8, 0xff])),
      })

      const full = makeRes()
      await handler(makeReq('GET', '/m/1000'), full.res)
      const thumb = makeRes()
      await handler(makeReq('GET', '/m/1000?variant=thumb'), thumb.res)

      expect(full.recorded.headers['etag']).toBe('"1000"')
      expect(thumb.recorded.headers['etag']).toBe('"1000|thumb160"')
      expect(full.recorded.headers['etag']).not.toBe(thumb.recorded.headers['etag'])
    })
  })

  describe('?kind=<preferKind> (crop-forced reel path)', () => {
    it('parseEventMediaKind returns null when unset', () => {
      expect(parseEventMediaKind('')).toBeNull()
      expect(parseEventMediaKind('variant=thumb')).toBeNull()
      expect(parseEventMediaKind('kind=')).toBeNull()
    })

    it('parseEventMediaKind reads the kind token', () => {
      expect(parseEventMediaKind('kind=crop')).toBe('crop')
      expect(parseEventMediaKind('variant=thumb&size=192&kind=crop')).toBe('crop')
    })

    it('passes the parsed preferKind to getMedia', async () => {
      let seenKind: string | undefined = 'UNSET'
      const handler = createEventMediaHandler({
        getMedia: async (_address, _variant, preferKind) => {
          seenKind = preferKind
          return makeMedia(1000, Uint8Array.from([0xff, 0xd8]))
        },
      })
      const req = makeReq('GET', '/m/1000?variant=thumb&kind=crop')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(200)
      expect(seenKind).toBe('crop')
    })

    it('passes undefined preferKind when no kind query is present', async () => {
      let seenKind: string | undefined = 'UNSET'
      const handler = createEventMediaHandler({
        getMedia: async (_address, _variant, preferKind) => {
          seenKind = preferKind
          return makeMedia(1, Uint8Array.from([0xff]))
        },
      })
      await handler(makeReq('GET', '/m/1?variant=thumb'), makeRes().res)
      expect(seenKind).toBeUndefined()
    })
  })

  describe('multi-segment path', () => {
    it('returns 404 for an /m/<id> address carrying a trailing slash — the id must be ALL digits', async () => {
      const handler = createEventMediaHandler({
        getMedia: async () => makeMedia(1, Uint8Array.from([0xff])),
      })

      const req = makeReq('GET', '/m/1/extra')
      const { res, recorded } = makeRes()
      await handler(req, res)

      expect(recorded.statusCode).toBe(404)
    })
  })
})
