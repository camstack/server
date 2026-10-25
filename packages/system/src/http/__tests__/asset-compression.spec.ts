/**
 * Unit cover for the negotiation rule, the eligibility allow-list and the
 * bounded compressed-bytes cache. The end-to-end wire behaviour (headers,
 * `content-length`, Range) is covered in `file-data-plane-compression.spec.ts`
 * against a REAL http server, because that is where a wrong `content-length`
 * shows up as a truncated or hanging response.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  COMPRESSION_MAX_ASSET_BYTES,
  getAssetCompressionStats,
  getCompressedAsset,
  isCompressibleContentType,
  negotiateContentEncoding,
  resetAssetCompressionCache,
} from '../asset-compression.js'

const body = (): Buffer => Buffer.from('x'.repeat(4096) + JSON.stringify({ a: 1 }))

/** Narrow away the identity fallback so assertions read without `!`. */
function bytes(value: Buffer | null): Buffer {
  if (value === null) throw new Error('expected compressed bytes, got the identity fallback')
  return value
}

describe('negotiateContentEncoding', () => {
  it('prefers brotli when the client offers both', () => {
    expect(negotiateContentEncoding('gzip, deflate, br')).toBe('br')
    expect(negotiateContentEncoding('br;q=0.5, gzip;q=1.0')).toBe('br')
  })

  it('falls back to gzip when brotli is not offered', () => {
    expect(negotiateContentEncoding('gzip, deflate')).toBe('gzip')
  })

  it('returns identity when the header is absent or empty', () => {
    expect(negotiateContentEncoding(undefined)).toBeNull()
    expect(negotiateContentEncoding('')).toBeNull()
  })

  it('returns identity when only codings we do not produce are offered', () => {
    expect(negotiateContentEncoding('deflate, zstd')).toBeNull()
    expect(negotiateContentEncoding('identity')).toBeNull()
  })

  it('honours an explicit q=0 rejection', () => {
    expect(negotiateContentEncoding('br;q=0, gzip')).toBe('gzip')
    expect(negotiateContentEncoding('br;q=0, gzip;q=0')).toBeNull()
  })

  it('treats a wildcard as accepting brotli', () => {
    expect(negotiateContentEncoding('*')).toBe('br')
    expect(negotiateContentEncoding('*;q=0')).toBeNull()
  })
})

describe('isCompressibleContentType', () => {
  it('accepts text, script, style, json, svg and wasm', () => {
    for (const t of [
      'text/html; charset=utf-8',
      'text/css; charset=utf-8',
      'application/javascript; charset=utf-8',
      'application/json; charset=utf-8',
      'application/manifest+json',
      'application/wasm',
      'image/svg+xml',
      'application/vnd.apple.mpegurl',
    ]) {
      expect(isCompressibleContentType(t), t).toBe(true)
    }
  })

  it('refuses already-compressed media and unknown binary', () => {
    for (const t of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'font/woff2',
      'application/octet-stream',
      '',
    ]) {
      expect(isCompressibleContentType(t), t).toBe(false)
    }
  })
})

describe('getCompressedAsset', () => {
  beforeEach(() => {
    resetAssetCompressionCache()
  })

  it('compresses ONCE across repeated requests for the same key', async () => {
    const key = { path: '/a/app.js', mtimeMs: 1, size: 4096, encoding: 'br' } as const
    let reads = 0
    const read = async (): Promise<Buffer> => {
      reads += 1
      return body()
    }

    const first = await getCompressedAsset(key, read)
    const second = await getCompressedAsset(key, read)

    expect(bytes(second).equals(bytes(first))).toBe(true)
    expect(reads).toBe(1)
    expect(getAssetCompressionStats().compressions).toBe(1)
    expect(getAssetCompressionStats().hits).toBe(1)
  })

  it('runs zlib once when the SAME key is requested concurrently', async () => {
    const key = { path: '/a/app.js', mtimeMs: 1, size: 4096, encoding: 'gzip' } as const
    const [a, b] = await Promise.all([
      getCompressedAsset(key, async () => body()),
      getCompressedAsset(key, async () => body()),
    ])
    expect(bytes(a).equals(bytes(b))).toBe(true)
    expect(getAssetCompressionStats().compressions).toBe(1)
  })

  it('treats a rebuild-in-place (same path, new mtime) as a MISS', async () => {
    const read = async (): Promise<Buffer> => body()
    await getCompressedAsset({ path: '/a/app.js', mtimeMs: 1, size: 4096, encoding: 'br' }, read)
    await getCompressedAsset({ path: '/a/app.js', mtimeMs: 2, size: 4096, encoding: 'br' }, read)
    expect(getAssetCompressionStats().compressions).toBe(2)
  })

  it('keys on the encoding — br and gzip are separate entries', async () => {
    const read = async (): Promise<Buffer> => body()
    const br = await getCompressedAsset(
      { path: '/a/app.js', mtimeMs: 1, size: 4096, encoding: 'br' },
      read,
    )
    const gz = await getCompressedAsset(
      { path: '/a/app.js', mtimeMs: 1, size: 4096, encoding: 'gzip' },
      read,
    )
    expect(bytes(br).equals(bytes(gz))).toBe(false)
    expect(getAssetCompressionStats().entries).toBe(2)
  })

  it('refuses to buffer an asset over the ceiling', async () => {
    let reads = 0
    const out = await getCompressedAsset(
      {
        path: '/a/huge.json',
        mtimeMs: 1,
        size: COMPRESSION_MAX_ASSET_BYTES + 1,
        encoding: 'br',
      },
      async () => {
        reads += 1
        return body()
      },
    )
    expect(out).toBeNull()
    expect(reads).toBe(0)
  })

  it('keeps the cache bounded — it never grows past its entry ceiling', async () => {
    for (let i = 0; i < 200; i += 1) {
      await getCompressedAsset(
        { path: `/a/app-${String(i)}.js`, mtimeMs: 1, size: 4096, encoding: 'br' },
        async () => body(),
      )
    }
    const stats = getAssetCompressionStats()
    expect(stats.compressions).toBe(200)
    expect(stats.entries).toBeLessThanOrEqual(64)
    expect(stats.bytes).toBeLessThanOrEqual(32 * 1024 * 1024)
  })

  it('falls back to identity when compression does not shrink the body', async () => {
    // Random bytes are incompressible — brotli adds framing and comes out bigger.
    const noise = Buffer.alloc(2048)
    for (let i = 0; i < noise.length; i += 1) noise[i] = (Math.random() * 256) | 0
    const out = await getCompressedAsset(
      { path: '/a/noise.json', mtimeMs: 1, size: noise.length, encoding: 'gzip' },
      async () => noise,
    )
    expect(out).toBeNull()
  })

  it('degrades to identity when the source cannot be read', async () => {
    const out = await getCompressedAsset(
      { path: '/a/gone.js', mtimeMs: 1, size: 4096, encoding: 'br' },
      async () => {
        throw new Error('ENOENT')
      },
    )
    expect(out).toBeNull()
  })
})
