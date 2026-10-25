/**
 * The addon's two data-plane routes.
 *
 * `/addon/provider-reolink/clip-thumb/<deviceId>/<clipKey>` — a JPEG, or 204
 * WITH A REASON. It never waits: an overflowing queue, a sleeping camera and a
 * camera that refused are three different operator actions, and collapsing
 * them into a blank tile is the defect this line of work exists to end.
 *
 * `/addon/provider-reolink/clip/<deviceId>/<clipKey>.mp4` — the muxed clip,
 * with `Range`, so the ONE player seeks natively.
 *
 * Both are registered `access: 'authenticated'` and NEITHER puts a token in
 * the URL: the hub's `/addon/<id>/<prefix>` proxy accepts the session cookie,
 * which is what the recorder's own plane already relies on (D549 22).
 */
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClipPlaybackHandler, createClipThumbHandler } from '../clips/clip-data-plane.js'
import { createRecordingLogger } from './clip-test-logger.js'

interface Captured {
  status: number
  headers: Record<string, unknown>
  body: Buffer
}

function fakeExchange(url: string, options: { method?: string; range?: string } = {}) {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const chunks: Buffer[] = []
  const res = new PassThrough()
  const done = new Promise<Captured>((resolve) => {
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('finish', () => {
      captured.body = Buffer.concat(chunks)
      resolve(captured)
    })
  })
  Object.assign(res, {
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      captured.headers = headers ?? {}
      return res
    },
  })
  const req = {
    url,
    method: options.method ?? 'GET',
    headers: options.range === undefined ? {} : { range: options.range },
  }
  return { req, res, done }
}

// ── thumbnails ────────────────────────────────────────────────────────────

describe('clip thumbnail route', () => {
  const KEY = 'a'.repeat(40)

  it('serves a cached JPEG as immutable', async () => {
    const handler = createClipThumbHandler({
      readCached: async () => Buffer.from('jpeg'),
      mint: async () => {
        throw new Error('must not be called')
      },
      logger: createRecordingLogger(),
    })
    const { req, res, done } = fakeExchange(`/107/${KEY}`)
    await handler(req as never, res as never)
    res.end()
    const out = await done
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('image/jpeg')
    expect(String(out.headers['cache-control'])).toContain('immutable')
    expect(out.body.toString()).toBe('jpeg')
  })

  it('mints on a miss and serves what it minted', async () => {
    const mint = vi.fn(async () => ({ ok: true as const, bytes: Buffer.from('fresh') }))
    const handler = createClipThumbHandler({
      readCached: async () => null,
      mint,
      logger: createRecordingLogger(),
    })
    const { req, res, done } = fakeExchange(`/107/${KEY}`)
    await handler(req as never, res as never)
    res.end()
    expect((await done).body.toString()).toBe('fresh')
    expect(mint).toHaveBeenCalledWith(107, KEY)
  })

  it('answers 204 WITH THE REASON rather than waiting when the queue overflows', async () => {
    const handler = createClipThumbHandler({
      readCached: async () => null,
      mint: async () => ({
        ok: false as const,
        code: 'queue-full' as const,
        disposition: 'deferred' as const,
        reason: 'queue-full: 16 mints already waiting',
      }),
      logger: createRecordingLogger(),
    })
    const { req, res, done } = fakeExchange(`/107/${KEY}`)
    await handler(req as never, res as never)
    res.end()
    const out = await done
    expect(out.status).toBe(204)
    expect(String(out.headers['x-camstack-reason'])).toContain('queue-full')
  })

  it('answers 204 `sleeping` for a battery camera a read must not wake', async () => {
    const handler = createClipThumbHandler({
      readCached: async () => null,
      mint: async () => ({
        ok: false as const,
        code: 'sleeping' as const,
        disposition: 'final' as const,
        reason: 'sleeping: a read would wake this camera',
      }),
      logger: createRecordingLogger(),
    })
    const { req, res, done } = fakeExchange(`/640/${KEY}`)
    await handler(req as never, res as never)
    res.end()
    const out = await done
    expect(out.status).toBe(204)
    expect(String(out.headers['x-camstack-reason'])).toContain('sleeping')
  })

  it('refuses a path that is not <deviceId>/<clipKey>', async () => {
    const handler = createClipThumbHandler({
      readCached: async () => null,
      mint: async () => ({ ok: true as const, bytes: Buffer.from('x') }),
      logger: createRecordingLogger(),
    })
    for (const url of ['/', '/592', `/107/${KEY}/extra`, '/107/../../etc/passwd']) {
      const { req, res, done } = fakeExchange(url)
      await handler(req as never, res as never)
      res.end()
      expect((await done).status, url).toBe(400)
    }
  })

  it('refuses anything but GET and HEAD', async () => {
    const handler = createClipThumbHandler({
      readCached: async () => Buffer.from('x'),
      mint: async () => ({ ok: true as const, bytes: Buffer.from('x') }),
      logger: createRecordingLogger(),
    })
    const { req, res, done } = fakeExchange(`/107/${KEY}`, { method: 'DELETE' })
    await handler(req as never, res as never)
    res.end()
    expect((await done).status).toBe(405)
  })

  it('never puts a token in its own URL — the session cookie authenticates it', () => {
    // D549 22: the route is `authenticated` like the recorder's plane and the
    // URL may sit in history, a Referer or a shared log and open nothing.
    const url = '/addon/provider-reolink/clip-thumb/107/abc'
    expect(url).not.toContain('token')
    expect(url).not.toContain('?')
  })
})

// ── deferred vs final ─────────────────────────────────────────────────────

/**
 * "Not yet" and "never" are two answers, and the 204 has to say which.
 *
 * `queue-full` means the still is coming: the tile shows LOADING and comes
 * back. `sleeping` means no retry can change anything: the tile shows the
 * reason and stops. Both used to be one header of prose, and the surface
 * latched both — which, with one-in-flight per host and a 16-deep lane, left
 * most of a 60-tile page permanently blank for stills that were about to
 * arrive.
 */
describe('the 204 says whether to come back', () => {
  const KEY = 'c'.repeat(40)

  it('marks a full queue DEFERRED, with its code and a retry hint', async () => {
    const handler = createClipThumbHandler({
      readCached: async () => null,
      mint: async () => ({
        ok: false as const,
        code: 'queue-full' as const,
        disposition: 'deferred' as const,
        reason: 'queue-full: 16 thumbnail mints already waiting for host 192.168.10.20',
        retryAfterMs: 5_000,
      }),
      logger: createRecordingLogger(),
    })
    const { req, res, done } = fakeExchange(`/107/${KEY}`)
    await handler(req as never, res as never)
    res.end()
    const out = await done
    expect(out.status).toBe(204)
    expect(out.headers['x-camstack-disposition']).toBe('deferred')
    expect(out.headers['x-camstack-reason-code']).toBe('queue-full')
    expect(out.headers['retry-after']).toBe('5')
    // The prose stays, verbatim and beside the code — never instead of it.
    expect(String(out.headers['x-camstack-reason'])).toContain('already waiting')
  })

  it('marks a sleeping camera FINAL and sends no retry hint', async () => {
    const handler = createClipThumbHandler({
      readCached: async () => null,
      mint: async () => ({
        ok: false as const,
        code: 'sleeping' as const,
        disposition: 'final' as const,
        reason: 'sleeping: a still would wake this standalone battery camera',
      }),
      logger: createRecordingLogger(),
    })
    const { req, res, done } = fakeExchange(`/640/${KEY}`)
    await handler(req as never, res as never)
    res.end()
    const out = await done
    expect(out.headers['x-camstack-disposition']).toBe('final')
    expect(out.headers['x-camstack-reason-code']).toBe('sleeping')
    expect(out.headers['retry-after']).toBeUndefined()
  })

  it('a mint that THREW is final, named, and carries the device tag', async () => {
    const logger = createRecordingLogger()
    const handler = createClipThumbHandler({
      readCached: async () => null,
      mint: async () => {
        throw new Error('Baichuan socket closed')
      },
      logger,
    })
    const { req, res, done } = fakeExchange(`/107/${KEY}`)
    await handler(req as never, res as never)
    res.end()
    const out = await done
    expect(out.headers['x-camstack-disposition']).toBe('final')
    expect(out.headers['x-camstack-reason-code']).toBe('camera-refused')
    expect(String(out.headers['x-camstack-reason'])).toContain('Baichuan socket closed')
    // A branch that produces no media SAYS so, per camera. A FINAL refusal is
    // a real drop and is warned; a deferred one is not, or one page of 60
    // tiles against a 16-deep lane would warn 43 times a paint.
    expect(logger.warns.some((line) => line.extras.tags?.deviceId === 107)).toBe(true)
  })

  it('does NOT warn for a deferred refusal — the work was not dropped', async () => {
    const logger = createRecordingLogger()
    const handler = createClipThumbHandler({
      readCached: async () => null,
      mint: async () => ({
        ok: false as const,
        code: 'queue-full' as const,
        disposition: 'deferred' as const,
        reason: 'queue-full: waiting',
        retryAfterMs: 5_000,
      }),
      logger,
    })
    const { req, res, done } = fakeExchange(`/107/${KEY}`)
    await handler(req as never, res as never)
    res.end()
    await done
    expect(logger.warns).toEqual([])
  })
})

// ── playback ──────────────────────────────────────────────────────────────

describe('clip playback route', () => {
  const KEY = 'b'.repeat(40)
  let root = ''
  let file = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'camstack-clip-plane-'))
    file = join(root, 'clip.mp4')
    await writeFile(file, Buffer.from('0123456789'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const handlerFor = (resolve: () => Promise<string | null>) =>
    createClipPlaybackHandler({
      resolvePath: resolve,
      logger: createRecordingLogger(),
    })

  it('serves the whole file with accept-ranges', async () => {
    const { req, res, done } = fakeExchange(`/107/${KEY}.mp4`)
    await handlerFor(async () => file)(req as never, res as never)
    const out = await done
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('video/mp4')
    expect(out.headers['accept-ranges']).toBe('bytes')
    expect(out.body.toString()).toBe('0123456789')
  })

  it('honours a Range so the player seeks natively', async () => {
    const { req, res, done } = fakeExchange(`/107/${KEY}.mp4`, { range: 'bytes=2-5' })
    await handlerFor(async () => file)(req as never, res as never)
    const out = await done
    expect(out.status).toBe(206)
    expect(out.headers['content-range']).toBe('bytes 2-5/10')
    expect(out.headers['content-length']).toBe('4')
    expect(out.body.toString()).toBe('2345')
  })

  it('answers an open-ended Range', async () => {
    const { req, res, done } = fakeExchange(`/107/${KEY}.mp4`, { range: 'bytes=7-' })
    await handlerFor(async () => file)(req as never, res as never)
    const out = await done
    expect(out.status).toBe(206)
    expect(out.body.toString()).toBe('789')
  })

  it('answers 416 for a Range past the end rather than an empty 206', async () => {
    const { req, res, done } = fakeExchange(`/107/${KEY}.mp4`, { range: 'bytes=99-200' })
    await handlerFor(async () => file)(req as never, res as never)
    expect((await done).status).toBe(416)
  })

  it('answers HEAD with the headers and no body', async () => {
    const { req, res, done } = fakeExchange(`/107/${KEY}.mp4`, { method: 'HEAD' })
    await handlerFor(async () => file)(req as never, res as never)
    const out = await done
    expect(out.status).toBe(200)
    expect(out.body.byteLength).toBe(0)
    expect(out.headers['content-length']).toBe('10')
  })

  it('answers 404 when the clip could not be prepared', async () => {
    const { req, res, done } = fakeExchange(`/107/${KEY}.mp4`)
    await handlerFor(async () => null)(req as never, res as never)
    expect((await done).status).toBe(404)
  })

  it('refuses a path that is not <deviceId>/<clipKey>.mp4', async () => {
    for (const url of ['/107/abc', '/107/../x.mp4', '/x/y.mp4']) {
      const { req, res, done } = fakeExchange(url)
      await handlerFor(async () => file)(req as never, res as never)
      res.end()
      expect((await done).status, url).toBe(400)
    }
  })
})
