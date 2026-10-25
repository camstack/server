/**
 * The still route: 200 with a picture, or 204 with a reason a tile can read.
 *
 * Never a 404 and never a placeholder. The whole point of the disposition
 * header is that a tile can tell "it is coming" from "it is not": a page of
 * sixty tiles against one camera's single replay slot produces a run of
 * `queue-full`, and a surface that latched those as final left every one of
 * them blank for a picture that was seconds away.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import type { IScopedLogger } from '@camstack/types'

import { createClipThumbHandler } from '../clip-data-plane.js'
import { deferStill, refuseStill } from '../clip-still-refusal.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

interface Answered {
  status: number | null
  headers: Record<string, string>
  body: Buffer | null
}

function fakeResponse(): { res: ServerResponse; answered: Answered } {
  const answered: Answered = { status: null, headers: {}, body: null }
  const res = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      answered.status = status
      answered.headers = { ...answered.headers, ...headers }
      return res
    },
    end: (bytes?: Buffer) => {
      if (bytes !== undefined) answered.body = bytes
      return res
    },
  }
  // A documented type boundary: this route touches `writeHead` and `end`.
  return { res: res as unknown as ServerResponse, answered }
}

function request(url: string, method = 'GET'): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage
}

const KEY = 'a'.repeat(40)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb])

describe('the clip still route', () => {
  it('serves a cached still and never asks for a mint', async () => {
    const mint = vi.fn()
    const handler = createClipThumbHandler({
      logger,
      readCached: async () => JPEG,
      mint,
    })
    const { res, answered } = fakeResponse()
    await handler(request(`/1436/${KEY}`), res)
    expect(answered.status).toBe(200)
    expect(answered.headers['content-type']).toBe('image/jpeg')
    expect(answered.headers['content-length']).toBe('4')
    // A clip is a file and the frame cut from it does not change.
    expect(answered.headers['cache-control']).toContain('immutable')
    expect(answered.body).toEqual(JPEG)
    expect(mint).not.toHaveBeenCalled()
  })

  it('answers a HEAD with the headers and no body', async () => {
    const handler = createClipThumbHandler({ logger, readCached: async () => JPEG, mint: vi.fn() })
    const { res, answered } = fakeResponse()
    await handler(request(`/1436/${KEY}`, 'HEAD'), res)
    expect(answered.status).toBe(200)
    expect(answered.body).toBeNull()
  })

  it('carries a DEFERRED refusal with its retry hint, and a FINAL one without', async () => {
    const deferred = createClipThumbHandler({
      logger,
      readCached: async () => null,
      mint: async () => deferStill('queue-full', 'replay-busy: the stream has held it', 3_000),
    })
    const first = fakeResponse()
    await deferred(request(`/1436/${KEY}`), first.res)
    expect(first.answered.status).toBe(204)
    expect(first.answered.headers['x-camstack-reason-code']).toBe('queue-full')
    expect(first.answered.headers['x-camstack-disposition']).toBe('deferred')
    expect(first.answered.headers['retry-after']).toBe('3')

    const final = createClipThumbHandler({
      logger,
      readCached: async () => null,
      mint: async () => refuseStill('no-keyframe', 'ffmpeg produced no frame'),
    })
    const second = fakeResponse()
    await final(request(`/1436/${KEY}`), second.res)
    expect(second.answered.status).toBe(204)
    expect(second.answered.headers['x-camstack-disposition']).toBe('final')
    expect(second.answered.headers['retry-after']).toBeUndefined()
  })

  it('folds a refusal sentence into something a HEADER can carry (D611)', async () => {
    // Measured on THIS camera: an em dash in `SETUP … answered 500 — the
    // camera refused this replay` threw `Invalid character in header content`
    // and the client got a socket hang up on every clip the operator opened.
    const handler = createClipThumbHandler({
      logger,
      readCached: async () => null,
      mint: async () => refuseStill('camera-refused', 'answered 500 — “no”\nsecond line'),
    })
    const { res, answered } = fakeResponse()
    await handler(request(`/1436/${KEY}`), res)
    const reason = answered.headers['x-camstack-reason'] ?? ''
    expect(reason).not.toContain('—')
    expect(reason).not.toContain('\n')
    expect(Buffer.from(reason, 'latin1').toString('latin1')).toBe(reason)
  })

  it('refuses a path that is not a device and a safe key', async () => {
    const handler = createClipThumbHandler({ logger, readCached: async () => JPEG, mint: vi.fn() })
    for (const url of ['/1436/../../etc/passwd', '/notanumber/abc', `/1436/${KEY}.jpg`]) {
      const { res, answered } = fakeResponse()
      await handler(request(url), res)
      expect(answered.status).toBe(400)
    }
  })

  it('never lets a THROW become a "come back later"', async () => {
    // `null` from the queue is not a default: it is what makes a socket close
    // be named rather than quietly inherit a retry loop.
    const handler = createClipThumbHandler({
      logger,
      readCached: async () => null,
      mint: async () => {
        throw new Error('socket hang up')
      },
    })
    const { res, answered } = fakeResponse()
    await handler(request(`/1436/${KEY}`), res)
    expect(answered.status).toBe(204)
    expect(answered.headers['x-camstack-disposition']).toBe('final')
    expect(answered.headers['x-camstack-reason-code']).toBe('camera-refused')
  })
})
