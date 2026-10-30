/**
 * The still ROUTE: what a tile is handed, and what it is told when there is
 * no picture.
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CLIP_STILL_DISPOSITION_HEADER,
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import { createClipThumbHandler } from '../clip-data-plane.js'
import { deferStill, type MintResult, refuseStill } from '../clip-still-refusal.js'

const DEVICE_ID = 3836
const CLIP_KEY = '1790168287-1790168435'

function makeLogger(): IScopedLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

interface Probe {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Buffer | null
  readonly minted: string[]
  readonly logger: IScopedLogger
}

async function ask(options: {
  readonly url?: string
  readonly cached?: Buffer | null
  readonly mint?: MintResult
  readonly mintThrows?: boolean
  readonly method?: string
}): Promise<Probe> {
  const logger = makeLogger()
  const minted: string[] = []
  const handler = createClipThumbHandler({
    logger,
    readCached: async () => options.cached ?? null,
    mint: async (deviceId, clipKey) => {
      minted.push(`${String(deviceId)}|${clipKey}`)
      if (options.mintThrows === true) throw new Error('the socket went away')
      return options.mint ?? refuseStill('no-keyframe', 'nothing decodable there')
    },
  })
  let status = 0
  let headers: Record<string, string> = {}
  let body: Buffer | null = null
  const res = {
    writeHead: (code: number, given?: Record<string, string>) => {
      status = code
      headers = given ?? {}
    },
    end: (chunk?: Buffer) => {
      body = chunk ?? null
    },
    on: () => undefined,
    off: () => undefined,
  } as unknown as ServerResponse
  await handler(
    {
      method: options.method ?? 'GET',
      url: options.url ?? `/${String(DEVICE_ID)}/${CLIP_KEY}`,
      headers: {},
    } as unknown as IncomingMessage,
    res,
  )
  return { status, headers, body, minted, logger }
}

describe('the still route', () => {
  it('serves a cached JPEG without minting anything', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff])
    const probe = await ask({ cached: jpeg })
    expect(probe.status).toBe(200)
    expect(probe.headers['content-type']).toBe('image/jpeg')
    expect(probe.headers['content-length']).toBe('3')
    expect(probe.body?.equals(jpeg)).toBe(true)
    expect(probe.minted).toEqual([])
  })

  it('mints when nothing is cached, and answers the bytes', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const probe = await ask({ mint: { ok: true, bytes: jpeg } })
    expect(probe.minted).toEqual([`${String(DEVICE_ID)}|${CLIP_KEY}`])
    expect(probe.status).toBe(200)
    expect(probe.body?.equals(jpeg)).toBe(true)
  })

  it('answers a FINAL refusal with 204, the code, the prose and the disposition', async () => {
    const probe = await ask({
      mint: refuseStill('camera-refused', 'the camera closed the connection'),
    })
    // 204, never 404: a still that does not exist is an absence, not a
    // missing route (D315).
    expect(probe.status).toBe(204)
    expect(probe.headers[CLIP_STILL_REASON_CODE_HEADER]).toBe('camera-refused')
    expect(probe.headers[CLIP_STILL_DISPOSITION_HEADER]).toBe('final')
    expect(probe.headers[CLIP_STILL_REASON_HEADER]).toContain('closed the connection')
    expect(probe.headers['retry-after']).toBeUndefined()
    // Work was dropped, so it is WARNED, per camera.
    expect(vi.mocked(probe.logger.warn)).toHaveBeenCalled()
    const extras = vi.mocked(probe.logger.warn).mock.calls[0]?.[1] as
      | { tags?: { deviceId?: number } }
      | undefined
    expect(extras?.tags?.deviceId).toBe(DEVICE_ID)
  })

  it('answers a DEFERRED refusal with a retry-after, and does not warn', async () => {
    const probe = await ask({
      mint: deferStill('queue-full', 'another mint holds this camera', 2_000),
    })
    expect(probe.status).toBe(204)
    expect(probe.headers[CLIP_STILL_DISPOSITION_HEADER]).toBe('deferred')
    expect(probe.headers[CLIP_STILL_REASON_CODE_HEADER]).toBe('queue-full')
    expect(probe.headers['retry-after']).toBe('2')
    expect(vi.mocked(probe.logger.warn)).not.toHaveBeenCalled()
  })

  it('names a mint that THREW rather than letting it become a 500', async () => {
    const probe = await ask({ mintThrows: true })
    expect(probe.status).toBe(204)
    expect(probe.headers[CLIP_STILL_REASON_CODE_HEADER]).toBe('camera-refused')
    expect(probe.headers[CLIP_STILL_REASON_HEADER]).toContain('socket went away')
  })

  it('refuses a path that is not /<deviceId>/<startSec>-<endSec>', async () => {
    const probe = await ask({ url: '/3836/../../etc/passwd' })
    expect(probe.status).toBe(400)
    expect(probe.minted).toEqual([])
  })

  it('answers HEAD with the headers and no body', async () => {
    const probe = await ask({
      cached: Buffer.from([0xff, 0xd8]),
      method: 'HEAD',
    })
    expect(probe.status).toBe(200)
    expect(probe.headers['content-length']).toBe('2')
    expect(probe.body).toBeNull()
  })
})

describe('the still route — a tile that went away', () => {
  it('tells the mint its caller is gone when the response closes first', async () => {
    let seen: AbortSignal | null = null
    let finish: (() => void) | null = null
    const handler = createClipThumbHandler({
      logger: makeLogger(),
      readCached: async () => null,
      mint: async (_deviceId, _clipKey, signal) => {
        seen = signal
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return deferStill('queue-full', 'the caller went away', 2_000)
      },
    })
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead: () => undefined,
      end: () => undefined,
    })
    const done = handler(
      {
        method: 'GET',
        url: `/${String(DEVICE_ID)}/${CLIP_KEY}`,
        headers: {},
      } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(seen).not.toBeNull()
    expect((seen as AbortSignal | null)?.aborted).toBe(false)
    res.emit('close')
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
    ;(finish as (() => void) | null)?.()
    await done
  })
})

describe('the still route — an abandoned mint', () => {
  it('writes no refusal for a caller that is already gone', async () => {
    const probe = await ask({ mint: { ok: false, abandoned: true, waitedMs: 40 } })
    expect(probe.status).toBe(0)
    expect(probe.headers[CLIP_STILL_REASON_CODE_HEADER]).toBeUndefined()
    expect(vi.mocked(probe.logger.warn)).not.toHaveBeenCalled()
  })
})
