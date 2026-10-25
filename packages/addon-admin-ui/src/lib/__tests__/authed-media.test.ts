import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authedFetchBlob,
  EVENT_MEDIA_BASE,
  filenameFromDisposition,
  mediaOwnerPath,
} from '../authed-media.js'

const ADMIN_TOKEN_STORAGE_KEY = 'camstack_admin_token'

function makeResponse(ok: boolean, status: number, blob: Blob): Response {
  return {
    ok,
    status,
    blob: () => Promise.resolve(blob),
  } as unknown as Response
}

describe('mediaOwnerPath (D694 generation)', () => {
  it('mints a bare owner path when generation is omitted', () => {
    expect(mediaOwnerPath('object', '101314')).toBe(`${EVENT_MEDIA_BASE}/o/object/101314`)
    expect(mediaOwnerPath('track', 'abc')).toBe(`${EVENT_MEDIA_BASE}/o/track/abc`)
  })

  it('appends /g/<deviceId>/<recordAt> for an event owner', () => {
    expect(mediaOwnerPath('object', '101314', { deviceId: 104, recordAt: 1_727_800_000_000 })).toBe(
      `${EVENT_MEDIA_BASE}/o/object/101314/g/104/1727800000000`,
    )
  })

  it('ignores generation on a non-event owner', () => {
    expect(mediaOwnerPath('track', 'abc', { deviceId: 1, recordAt: 2 })).toBe(
      `${EVENT_MEDIA_BASE}/o/track/abc`,
    )
  })
})

describe('authedFetchBlob', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the Authorization: Bearer header when a token exists', async () => {
    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, 'tok-123')
    const blob = new Blob(['x'])
    fetchMock.mockResolvedValue(makeResponse(true, 200, blob))

    await authedFetchBlob('/some/url')

    expect(fetchMock).toHaveBeenCalledWith('/some/url', {
      headers: { Authorization: 'Bearer tok-123' },
    })
  })

  it('omits the Authorization header when no token is present', async () => {
    const blob = new Blob(['x'])
    fetchMock.mockResolvedValue(makeResponse(true, 200, blob))

    await authedFetchBlob('/some/url')

    expect(fetchMock).toHaveBeenCalledWith('/some/url', { headers: {} })
  })

  it('returns res.blob() on a 2xx response', async () => {
    const blob = new Blob(['payload'])
    fetchMock.mockResolvedValue(makeResponse(true, 200, blob))

    const result = await authedFetchBlob('/some/url')

    expect(result).toBe(blob)
  })

  it('throws on a non-2xx response (404)', async () => {
    fetchMock.mockResolvedValue(makeResponse(false, 404, new Blob()))

    await expect(authedFetchBlob('/missing')).rejects.toThrow('media fetch failed: 404')
  })

  it('exposes the event-media base path', () => {
    expect(EVENT_MEDIA_BASE).toBe('/addon/pipeline-analytics/event-media')
  })
})

/**
 * `filenameFromDisposition` — the name the browser saves the bundle under.
 *
 * The archive endpoints stamp a timestamp into `content-disposition`, and the
 * caller's fallback name has none: parsing this wrong means every export lands
 * as the same filename and silently overwrites the last one.
 */
describe('filenameFromDisposition', () => {
  it('reads the plain filename form', () => {
    expect(filenameFromDisposition('attachment; filename="camstack-debug-2026.zip"')).toBe(
      'camstack-debug-2026.zip',
    )
  })

  it('reads it without quotes', () => {
    expect(filenameFromDisposition('attachment; filename=bundle.zip')).toBe('bundle.zip')
  })

  it('prefers the RFC 5987 extended form, and decodes it', () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="fallback.zip"; filename*=UTF-8\'\'caf%C3%A8.zip',
      ),
    ).toBe('cafè.zip')
  })

  it('falls back to the plain form when the extended one is malformed', () => {
    expect(
      filenameFromDisposition('attachment; filename="good.zip"; filename*=UTF-8\'\'%E0%A4%A'),
    ).toBe('good.zip')
  })

  it('returns null when there is no header, or no filename in it', () => {
    expect(filenameFromDisposition(null)).toBeNull()
    expect(filenameFromDisposition('attachment')).toBeNull()
  })
})
