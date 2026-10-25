/**
 * The addon data-plane serves its static assets with its OWN content-coding.
 *
 * Driven through a REAL `node:http` server with a RAW `http.request` client —
 * deliberately not `fetch`, which transparently decodes the body and hides the
 * `content-length` the server actually wrote. A `content-length` that disagrees
 * with the bytes emitted truncates or hangs the response, and that is exactly
 * the failure a decoding client would hide from this test.
 *
 * Context for why the addon compresses at all: the hub's `/addon/:addonId/*`
 * bridge is `{ compress: false }` after the global compressor was found emitting
 * EMPTY brotli over the forked-addon route bridge (2026-07-16). Nothing above
 * this layer will compress an addon body, so this layer must.
 */

import { promises as fs } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAssetCompressionStats, resetAssetCompressionCache } from '../asset-compression.js'
import { createFileDataPlaneHandler } from '../file-data-plane.js'

/** ~1.4 MB of realistic, highly compressible bundle text. */
const BUNDLE = `${'export const chunk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n'.repeat(4000)}`
/**
 * Below COMPRESSION_MIN_BYTES (1024) but HIGHLY compressible — so the only
 * thing that can keep it uncompressed is the floor itself. A 19-byte file would
 * also come back identity because brotli's framing makes it bigger, which would
 * make this test pass with the floor deleted.
 */
const TINY = 'a'.repeat(900)

interface RawResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer
}

let root: string
let server: Server
let port: number

async function get(
  urlPath: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<RawResponse> {
  return await new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const flat: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') flat[k] = v
          else if (Array.isArray(v)) flat[k] = v.join(',')
        }
        resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks) })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  resetAssetCompressionCache()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'camstack-dataplane-'))
  await fs.mkdir(path.join(root, 'assets'), { recursive: true })
  await fs.writeFile(path.join(root, 'assets', 'index-abc123.js'), BUNDLE)
  await fs.writeFile(path.join(root, 'assets', 'tiny.js'), TINY)
  await fs.writeFile(path.join(root, 'assets', 'photo.jpg'), Buffer.alloc(64 * 1024, 0x7f))
  await fs.writeFile(path.join(root, 'index.html'), `<!doctype html>${'<p>x</p>'.repeat(400)}`)

  const handler = createFileDataPlaneHandler({ getRoots: () => [root] })
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  port = addr.port
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(root, { recursive: true, force: true })
})

describe('file data-plane — content-coding', () => {
  it('prefers brotli when the client offers both, and the body decodes to the original', async () => {
    const res = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip, deflate, br' })

    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers.vary).toBe('accept-encoding')
    expect(brotliDecompressSync(res.body).toString()).toBe(BUNDLE)
    // The whole point: the 1.4 MB bundle must not travel at 1.4 MB.
    expect(res.body.byteLength).toBeLessThan(Buffer.byteLength(BUNDLE) / 4)
  })

  it('falls back to gzip when brotli is not offered', async () => {
    const res = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip, deflate' })

    expect(res.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(res.body).toString()).toBe(BUNDLE)
  })

  it('sends identity when the client offers NO Accept-Encoding', async () => {
    const res = await get('/assets/index-abc123.js')

    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body.toString()).toBe(BUNDLE)
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(BUNDLE)))
  })

  it('never compresses an already-compressed media type', async () => {
    const res = await get('/assets/photo.jpg', { 'accept-encoding': 'br, gzip' })

    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['content-encoding']).toBeUndefined()
    // Not even a Vary — the representation does not depend on Accept-Encoding.
    expect(res.headers.vary).toBeUndefined()
    expect(res.body.byteLength).toBe(64 * 1024)
  })

  it('never compresses a payload below the floor', async () => {
    const res = await get('/assets/tiny.js', { 'accept-encoding': 'br, gzip' })

    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body.toString()).toBe(TINY)
    // Still varies: a shared cache must not reuse this entry across codings.
    expect(res.headers.vary).toBe('accept-encoding')
  })

  it('compresses ONCE and serves the cached bytes to a second request', async () => {
    const first = await get('/assets/index-abc123.js', { 'accept-encoding': 'br' })
    const second = await get('/assets/index-abc123.js', { 'accept-encoding': 'br' })

    expect(second.body.equals(first.body)).toBe(true)
    const stats = getAssetCompressionStats()
    expect(stats.compressions).toBe(1)
    expect(stats.hits).toBe(1)
  })

  it('content-length matches the bytes actually written, compressed and identity', async () => {
    for (const acceptEncoding of ['br', 'gzip', '']) {
      const res = await get(
        '/index.html',
        acceptEncoding === '' ? {} : { 'accept-encoding': acceptEncoding },
      )
      expect(res.headers['content-length'], acceptEncoding).toBe(String(res.body.byteLength))
    }
  })

  it('a HEAD advertises the same content-length the GET would send', async () => {
    const head = await get('/assets/index-abc123.js', { 'accept-encoding': 'br' }, 'HEAD')
    const body = await get('/assets/index-abc123.js', { 'accept-encoding': 'br' })

    expect(head.body.byteLength).toBe(0)
    expect(head.headers['content-encoding']).toBe('br')
    expect(head.headers['content-length']).toBe(String(body.body.byteLength))
  })

  it('serves a Range request as identity — a byte range into a coded body is meaningless', async () => {
    const res = await get('/assets/index-abc123.js', {
      'accept-encoding': 'br, gzip',
      range: 'bytes=0-99',
    })

    expect(res.status).toBe(206)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['content-length']).toBe('100')
    expect(res.body.byteLength).toBe(100)
    expect(res.body.toString()).toBe(BUNDLE.slice(0, 100))
  })

  it('does not advertise byte ranges for a compressed representation', async () => {
    const res = await get('/assets/index-abc123.js', { 'accept-encoding': 'br' })
    expect(res.headers['accept-ranges']).toBe('none')
  })
})
