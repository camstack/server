/**
 * The mint route answers 200 with an image or **204 with a reason**, and the
 * refusal has to be LATCHED, not retried.
 *
 * An `<img src>` cannot see a 204's `x-camstack-reason` header: it fires
 * `onerror` with nothing to say, which is how a named refusal ("the camera is
 * busy") becomes an anonymous broken tile. So a mint goes through `fetch` —
 * with the session cookie, no token in the URL (D549 decision 22) — and the
 * header is read off the response.
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchMintedThumbnail } from '../clip-thumbnail-fetch.js'

function responseOf(status: number, reason?: string, extra: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : new Blob(['x'], { type: 'image/jpeg' }), {
    status,
    headers: reason === undefined ? extra : { 'x-camstack-reason': reason, ...extra },
  })
}

describe('fetchMintedThumbnail', () => {
  it('sends the session cookie and appends NOTHING to the URL', async () => {
    const fetcher = vi.fn(async () => responseOf(200))
    await fetchMintedThumbnail('/addon/provider-reolink/clip-thumb/592/abc', fetcher)
    expect(fetcher).toHaveBeenCalledWith('/addon/provider-reolink/clip-thumb/592/abc', {
      credentials: 'same-origin',
    })
  })

  it('turns a 204 into the named refusal the header carries', async () => {
    const result = await fetchMintedThumbnail('/mint', async () => responseOf(204, 'queue-full'))
    expect(result.kind).toBe('unavailable')
    expect(result.kind === 'unavailable' ? result.reason : '').toBe('queue-full')
  })

  // ── the deferred/final split, as it really arrives ──────────────────────

  it('reports a DEFERRED 204 as deferred, with the server’s own retry hint', async () => {
    const result = await fetchMintedThumbnail('/mint', async () =>
      responseOf(204, 'queue-full: 16 waiting for host 192.168.10.20', {
        'x-camstack-reason-code': 'queue-full',
        'x-camstack-disposition': 'deferred',
        'retry-after': '5',
      }),
    )
    expect(result.kind).toBe('deferred')
    expect(result.kind === 'deferred' ? result.retryAfterMs : 0).toBe(5_000)
    expect(result.kind === 'deferred' ? result.text : '').toMatch(/waiting for the camera/i)
  })

  it('reports a FINAL 204 as unavailable, with words keyed on the code', async () => {
    const result = await fetchMintedThumbnail('/mint', async () =>
      responseOf(204, 'sleeping: a still would wake this standalone battery camera', {
        'x-camstack-reason-code': 'sleeping',
        'x-camstack-disposition': 'final',
      }),
    )
    expect(result.kind).toBe('unavailable')
    expect(result.kind === 'unavailable' ? result.text : '').toMatch(/asleep/i)
  })

  it('a 204 from an addon that predates the split is FINAL, exactly as before', async () => {
    // No code header, no disposition header. This is what every deployed
    // provider-reolink answers until the route ships, and it must keep
    // latching rather than start a retry loop against a build nobody tested.
    const result = await fetchMintedThumbnail('/mint', async () =>
      responseOf(204, 'queue-full: 16 mints already waiting'),
    )
    expect(result.kind).toBe('unavailable')
  })

  it('a deferred 204 with NO retry hint still defers — the client has its own floor', async () => {
    const result = await fetchMintedThumbnail('/mint', async () =>
      responseOf(204, 'queue-full', {
        'x-camstack-reason-code': 'queue-full',
        'x-camstack-disposition': 'deferred',
      }),
    )
    expect(result.kind).toBe('deferred')
    expect(result.kind === 'deferred' ? result.retryAfterMs : 0).toBeNull()
  })

  it('a NETWORK failure is deferred, not final — the camera never said no', async () => {
    // A tile that goes permanently blank because one request lost a race is
    // the same defect with a different cause.
    const result = await fetchMintedThumbnail('/mint', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(result.kind).toBe('deferred')
  })

  it('a 204 with NO reason header is still a refusal, not a blank tile', async () => {
    const result = await fetchMintedThumbnail('/mint', async () => responseOf(204))
    expect(result.kind).toBe('unavailable')
  })

  it('a non-OK status is a refusal that names the status', async () => {
    const result = await fetchMintedThumbnail('/mint', async () => responseOf(503))
    expect(result.kind === 'unavailable' ? result.reason : '').toContain('503')
  })

  it('a thrown fetch is an answer, never a rejection the caller must catch', async () => {
    const result = await fetchMintedThumbnail('/mint', async () => {
      throw new Error('offline')
    })
    // Deferred, because nothing said no: the tile comes back under its bound
    // and then says this, rather than going blank on one lost request.
    expect(result.kind).toBe('deferred')
    expect(result.kind === 'deferred' ? result.text : '').toContain('offline')
  })
})
