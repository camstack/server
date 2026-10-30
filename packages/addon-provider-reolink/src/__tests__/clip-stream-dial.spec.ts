/**
 * The clip stream's DIAL listener (D597): the same stream handler as the data
 * plane, behind a one-shot token on a real loopback socket.
 */
import { get as httpGet, request as httpRequest, type IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ClipStreamRouteOutcome,
  ClipStreamRouteSink,
  ClipStreamTarget,
} from '../clips/clip-data-plane.js'
import { type ClipStreamDial, createClipStreamDial } from '../clips/clip-stream-dial.js'
import { createRecordingLogger } from './clip-test-logger.js'

interface Exchange {
  readonly status: number
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
}

function fetchOnce(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      )
      res.on('error', reject)
    }
    if (method === 'GET') httpGet(url, onResponse).on('error', reject)
    else httpRequest(url, { method }, onResponse).on('error', reject).end()
  })
}

/** A route that streams three chunks for (592, KEY) and refuses anything else. */
const KEY = 'a'.repeat(40)
function streamingRoute() {
  return vi.fn(
    async (
      target: ClipStreamTarget,
      sink: ClipStreamRouteSink,
    ): Promise<ClipStreamRouteOutcome> => {
      if (target.deviceId !== 107 || target.clipKey !== KEY) {
        return { kind: 'refused', code: 'no-catalog-row', detail: 'no-catalog-row: not listed' }
      }
      sink.begin('video/mp4')
      for (const part of ['ftyp', 'moov', 'moof+mdat']) sink.write(Buffer.from(part))
      sink.end()
      return { kind: 'served' }
    },
  )
}

const dials: ClipStreamDial[] = []
afterEach(async () => {
  while (dials.length > 0) await dials.pop()?.dispose()
})

function harness(options: { ttlMs?: number; maxOutstanding?: number; now?: () => number } = {}) {
  const logger = createRecordingLogger()
  const stream = streamingRoute()
  const dial = createClipStreamDial({ logger, stream, ...options })
  dials.push(dial)
  return { dial, logger, stream }
}

describe('createClipStreamDial', () => {
  it('mints a one-shot loopback URL and serves the SAME stream handler behind it', async () => {
    const h = harness()
    const minted = await h.dial.mint({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' })
    expect(minted.kind).toBe('ticket')
    if (minted.kind !== 'ticket') return
    expect(minted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}$/)
    expect(h.dial.outstanding).toBe(1)
    const out = await fetchOnce(minted.url)
    expect(out.status).toBe(200)
    expect(out.headers['x-camstack-clip-transport']).toBe('forward-only')
    expect(out.headers['accept-ranges']).toBe('none')
    expect(out.body.toString()).toBe('ftypmoovmoof+mdat')
    // The whole target the dial was minted with reaches the route — the twin
    // and the audio ask included, which is what makes `served` honest (D600).
    expect(h.stream).toHaveBeenCalledWith(
      { deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' },
      expect.anything(),
    )
    expect(h.dial.outstanding).toBe(0)
    const taken = h.logger.infos.find((l) => l.message.includes('dial was taken'))
    expect(taken?.extras.tags).toEqual({ deviceId: 107 })
    const mintedLine = h.logger.infos.find((l) => l.message.includes('dial minted'))
    expect(mintedLine?.extras.tags).toEqual({ deviceId: 107 })
    expect(mintedLine?.extras.meta?.['twin']).toBe('sub')
  })

  it('a second GET on the same token is 410 `dial-used`; the camera is not touched again', async () => {
    const h = harness()
    const minted = await h.dial.mint({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' })
    if (minted.kind !== 'ticket') throw new Error(minted.detail)
    await fetchOnce(minted.url)
    const again = await fetchOnce(minted.url)
    expect(again.status).toBe(410)
    expect(again.headers['x-camstack-reason-code']).toBe('dial-used')
    expect(h.stream).toHaveBeenCalledTimes(1)
  })

  it('an unknown token is 404 `dial-unknown`, an expired one 410 `dial-expired`', async () => {
    let clock = 1_000_000
    const h = harness({ ttlMs: 1_000, now: () => clock })
    const minted = await h.dial.mint({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' })
    if (minted.kind !== 'ticket') throw new Error(minted.detail)
    expect(minted.expiresAtMs).toBe(1_001_000)
    const base = minted.url.slice(0, minted.url.lastIndexOf('/'))
    const unknown = await fetchOnce(`${base}/${'x'.repeat(32)}`)
    expect(unknown.status).toBe(404)
    expect(unknown.headers['x-camstack-reason-code']).toBe('dial-unknown')
    clock += 1_001
    const expired = await fetchOnce(minted.url)
    expect(expired.status).toBe(410)
    expect(expired.headers['x-camstack-reason-code']).toBe('dial-expired')
    expect(h.stream).not.toHaveBeenCalled()
    expect(h.dial.outstanding).toBe(0)
    // The refusal is one line, with its code — the only line here with no
    // device tag, because a token that names no clip names no camera.
    const warn = h.logger.warns.find((l) => l.message.includes('names no clip'))
    expect(warn?.extras.meta?.['code']).toBe('dial-unknown')
  })

  it('HEAD answers the stream headers and does NOT take the token', async () => {
    const h = harness()
    const minted = await h.dial.mint({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' })
    if (minted.kind !== 'ticket') throw new Error(minted.detail)
    const head = await fetchOnce(minted.url, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['x-camstack-clip-transport']).toBe('forward-only')
    expect(h.dial.outstanding).toBe(1)
    expect(h.stream).not.toHaveBeenCalled()
    const out = await fetchOnce(minted.url)
    expect(out.status).toBe(200)
  })

  it('refuses to mint past the outstanding bound, by name, per camera', async () => {
    const h = harness({ maxOutstanding: 2 })
    await h.dial.mint({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' })
    await h.dial.mint({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' })
    const third = await h.dial.mint({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' })
    expect(third).toMatchObject({ kind: 'refused', code: 'dial-exhausted' })
    const warn = h.logger.warns.find((l) => l.message.includes('too many outstanding'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
  })

  it('a refusal from the route travels as a status with the reason code', async () => {
    const h = harness()
    const minted = await h.dial.mint({
      deviceId: 107,
      clipKey: 'b'.repeat(40),
      twin: 'sub',
      audio: 'none',
    })
    if (minted.kind !== 'ticket') throw new Error(minted.detail)
    const out = await fetchOnce(minted.url)
    expect(out.status).toBe(404)
    expect(out.headers['x-camstack-reason-code']).toBe('no-catalog-row')
  })

  it('dispose closes the listener: the URL stops answering', async () => {
    const h = harness()
    const minted = await h.dial.mint({ deviceId: 107, clipKey: KEY, twin: 'sub', audio: 'none' })
    if (minted.kind !== 'ticket') throw new Error(minted.detail)
    await h.dial.dispose()
    await expect(fetchOnce(minted.url)).rejects.toThrow()
    expect(h.dial.outstanding).toBe(0)
  })
})
