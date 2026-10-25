/**
 * The retrain-frame data plane: pixels over HTTP, not base64 inside a cap
 * answer (D613). Exercised over a real listener so headers and bodies are the
 * ones a browser would see.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  createRetrainFrameHandler,
  parseRetrainFrameRequest,
  RETRAIN_THUMB_MAX_SIDE,
  retrainFramePath,
} from '../retrain-frame-handler.js'

const FULL = Buffer.from('full-frame-bytes')
const THUMB = Buffer.from('thumb')

let server: Server
let base: string
let resizedTo: number[]

beforeEach(async () => {
  resizedTo = []
  const handler = createRetrainFrameHandler({
    readFrame: async (frameId) => (frameId === 'retrain:t:abc' ? FULL : null),
    resize: async (_bytes, maxSide) => {
      resizedTo.push(maxSide)
      return THUMB
    },
    logger: makeSilentLogger(),
  })
  server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('parseRetrainFrameRequest', () => {
  it('reads an encoded frame id and defaults to the full size', () => {
    expect(parseRetrainFrameRequest('/retrain%3At%3Aabc')).toEqual({
      frameId: 'retrain:t:abc',
      size: 'full',
    })
  })

  it('reads the size, and refuses an unknown one, an empty id and a nested path', () => {
    expect(parseRetrainFrameRequest('/x?size=thumb')?.size).toBe('thumb')
    expect(parseRetrainFrameRequest('/x?size=huge')).toBeNull()
    expect(parseRetrainFrameRequest('/')).toBeNull()
    expect(parseRetrainFrameRequest('/a/b')).toBeNull()
  })

  it('round-trips the path the server mints', () => {
    const path = retrainFramePath('pipeline-analytics', 'retrain:t:abc', 'thumb')
    expect(path).toBe('/addon/pipeline-analytics/retrain-frame/retrain%3At%3Aabc?size=thumb')
  })
})

describe('retrain-frame handler', () => {
  it('serves the stored copy byte for byte at full size', async () => {
    const res = await fetch(`${base}/retrain%3At%3Aabc?size=full`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FULL)
    expect(resizedTo).toEqual([])
  })

  it('serves a downscaled thumbnail for a grid', async () => {
    const res = await fetch(`${base}/retrain%3At%3Aabc?size=thumb`)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(THUMB)
    expect(resizedTo).toEqual([RETRAIN_THUMB_MAX_SIDE])
  })

  it('answers 404 for a frame that is gone and 304 for a matching ETag', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    const first = await fetch(`${base}/retrain%3At%3Aabc`)
    const etag = first.headers.get('etag')
    expect(etag).not.toBeNull()
    const again = await fetch(`${base}/retrain%3At%3Aabc`, {
      headers: { 'if-none-match': etag ?? '' },
    })
    expect(again.status).toBe(304)
  })

  it('refuses anything but GET and HEAD', async () => {
    expect((await fetch(`${base}/retrain%3At%3Aabc`, { method: 'POST' })).status).toBe(405)
  })
})
