/**
 * Content-coding for addon-served static assets: `Accept-Encoding` negotiation,
 * an eligibility rule, and a BOUNDED cache of the compressed bytes.
 *
 * ## Why the ADDON owns the encoding
 *
 * The hub's `/addon/:addonId/*` bridge is registered `{ compress: false }`. That
 * is not an oversight — on 2026-07-16 the global `@fastify/compress` was found
 * emitting an EMPTY brotli stream (`content-encoding: br`, `content-length: 0`)
 * for any compressible body over its 1 KiB threshold once the body had crossed
 * the UDS route bridge of a FORKED addon. It silently broke the notifier SVG
 * icons; the deploy-bundle pull route had already dodged the same class with
 * `compress: false`. The resolution then, and the contract now, is that an addon
 * route owns its content-coding END TO END: it negotiates, it compresses, it
 * stamps `content-encoding` + `Vary`, and the hub pipes those bytes through
 * untouched (`proxyToUpstream` replays the upstream headers verbatim).
 *
 * So compression belongs HERE, in the shared file data-plane, and nowhere above
 * it. Anything that re-compresses on top of this reintroduces the empty-brotli
 * bug rather than doubling the ratio.
 *
 * ## Why the bytes are cached, and why the cache is bounded
 *
 * Measured on the stream-broker embed bundle (`index-<hash>.js`, 1,443,142 B):
 * gzip-6 → 360,868 B, brotli-5 → 327,419 B in 27 ms, brotli-11 → 293,677 B in
 * 2,233 ms. Quality 5 is the request-path choice: 77% off the wire for 27 ms
 * paid ONCE. Quality 11 buys another 2.3% for eighty times the CPU, on a path
 * where a real client is waiting.
 *
 * The cache is an LRU bounded by BOTH entry count and total bytes, and it
 * refuses assets over {@link COMPRESSION_MAX_ASSET_BYTES} outright. An unbounded
 * `Map` keyed by URL is how a long-lived process walks into an OOM, and this
 * repo has already spent a session on one.
 *
 * The key carries `mtimeMs` and `size`, so a rebuild that rewrites an asset in
 * place under an UNCHANGED name (an SPA shell, a service worker) can never be
 * served from the previous build's bytes.
 */

import { promisify } from 'node:util'
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib'

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/** The codings this layer will produce. Identity is the absence of one. */
export type ContentEncoding = 'br' | 'gzip'

/**
 * Below this the framing and the `Vary` cache split cost more than the
 * compression saves. Same threshold the hub's global compressor is registered
 * with, deliberately.
 */
export const COMPRESSION_MIN_BYTES = 1024

/**
 * Above this an asset is streamed identity and never buffered. Compression
 * requires the whole body in RAM twice; a multi-hundred-MB recording segment
 * must not be able to do that, whatever its content type says.
 */
export const COMPRESSION_MAX_ASSET_BYTES: number = 8 * 1024 * 1024

/** LRU bounds. Both are enforced; whichever binds first evicts. */
const MAX_CACHE_ENTRIES = 64
const MAX_CACHE_BYTES = 32 * 1024 * 1024

/** Brotli quality — see the file header for the measured trade. */
const BROTLI_QUALITY = 5

/**
 * Content types worth compressing. An ALLOW-list, not a deny-list: an unknown
 * type (`application/octet-stream`) is assumed to be opaque binary. This is what
 * keeps jpeg/png/webp/mp4/m4s/woff2 out — running brotli over them burns CPU to
 * make the body marginally BIGGER.
 */
const COMPRESSIBLE_EXACT: ReadonlySet<string> = new Set([
  'application/javascript',
  'application/ecmascript',
  'application/json',
  'application/manifest+json',
  'application/wasm',
  'application/xml',
  'application/xhtml+xml',
  'application/vnd.apple.mpegurl',
  'image/svg+xml',
])

/** Is a body of this content type worth compressing at all? */
export function isCompressibleContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base.length === 0) return false
  if (base.startsWith('text/')) return true
  if (base.endsWith('+json') || base.endsWith('+xml')) return true
  return COMPRESSIBLE_EXACT.has(base)
}

interface EncodingPreference {
  readonly token: string
  readonly q: number
}

/** Parse `Accept-Encoding` into tokens with their q-values (default 1). */
function parseAcceptEncoding(header: string | undefined): readonly EncodingPreference[] {
  if (header === undefined || header.trim().length === 0) return []
  const out: EncodingPreference[] = []
  for (const part of header.split(',')) {
    const [rawToken, ...params] = part.split(';')
    const token = rawToken?.trim().toLowerCase() ?? ''
    if (token.length === 0) continue
    let q = 1
    for (const param of params) {
      const [name, value] = param.split('=')
      if (name?.trim().toLowerCase() !== 'q') continue
      const parsed = Number(value?.trim())
      q = Number.isFinite(parsed) ? parsed : 1
    }
    out.push({ token, q })
  }
  return out
}

function accepts(prefs: readonly EncodingPreference[], token: ContentEncoding): boolean {
  const exact = prefs.find((p) => p.token === token)
  if (exact) return exact.q > 0
  const wildcard = prefs.find((p) => p.token === '*')
  return wildcard !== undefined && wildcard.q > 0
}

/**
 * Pick a coding for this request: brotli when offered, else gzip, else identity.
 *
 * Returns `null` for identity — including when the header is ABSENT. A client
 * that offers nothing gets the raw bytes; guessing on its behalf is how a
 * non-negotiating consumer (a native fetch, a probe, an OTA puller) ends up with
 * a body it cannot read.
 */
export function negotiateContentEncoding(
  acceptEncoding: string | undefined,
): ContentEncoding | null {
  const prefs = parseAcceptEncoding(acceptEncoding)
  if (prefs.length === 0) return null
  if (accepts(prefs, 'br')) return 'br'
  if (accepts(prefs, 'gzip')) return 'gzip'
  return null
}

/** Identity of one compressed body. `mtimeMs`+`size` make a rebuild-in-place a MISS. */
export interface CompressedAssetKey {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
  readonly encoding: ContentEncoding
}

/** Counters for the cache. Exported so a test can prove the compressor ran ONCE. */
export interface AssetCompressionStats {
  /** Bodies actually run through zlib. */
  readonly compressions: number
  /** Requests served from already-compressed bytes. */
  readonly hits: number
  readonly entries: number
  readonly bytes: number
}

const cache = new Map<string, Buffer>()
const inFlight = new Map<string, Promise<Buffer | null>>()
let compressions = 0
let hits = 0
let cachedBytes = 0

function cacheKey(key: CompressedAssetKey): string {
  // Path LAST: the three fields before it can never contain a `|`, so no
  // separator ambiguity is possible whatever a filename happens to hold.
  return `${key.encoding}|${String(key.mtimeMs)}|${String(key.size)}|${key.path}`
}

/** Evict least-recently-used entries until both bounds hold. */
function evictToBounds(): void {
  for (const [k, buf] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES && cachedBytes <= MAX_CACHE_BYTES) return
    cache.delete(k)
    cachedBytes -= buf.byteLength
  }
}

async function compressBody(raw: Buffer, encoding: ContentEncoding): Promise<Buffer> {
  if (encoding === 'gzip') return await gzipAsync(raw)
  return await brotliAsync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
    },
  })
}

/**
 * Compressed bytes for one asset, compressing at most once per key.
 *
 * `null` means "send the original" — the asset is too large to buffer, the
 * source could not be read, or compression did not actually shrink it. Every
 * failure degrades to identity, so this can only ever be an optimisation.
 *
 * Concurrent callers for the same key share ONE compression: a cold cache hit by
 * a dozen parallel asset requests must not run zlib a dozen times.
 */
export async function getCompressedAsset(
  key: CompressedAssetKey,
  readSource: () => Promise<Buffer>,
): Promise<Buffer | null> {
  if (key.size > COMPRESSION_MAX_ASSET_BYTES) return null

  const id = cacheKey(key)
  const cached = cache.get(id)
  if (cached) {
    // Re-insert to mark most-recently-used.
    cache.delete(id)
    cache.set(id, cached)
    hits += 1
    return cached
  }

  const pending =
    inFlight.get(id) ??
    (async (): Promise<Buffer | null> => {
      let raw: Buffer
      try {
        raw = await readSource()
      } catch {
        return null
      }
      const out = await compressBody(raw, key.encoding)
      compressions += 1
      if (out.byteLength >= raw.byteLength) return null
      cache.set(id, out)
      cachedBytes += out.byteLength
      evictToBounds()
      return out
    })()
  inFlight.set(id, pending)
  try {
    return await pending
  } catch {
    return null
  } finally {
    inFlight.delete(id)
  }
}

export function getAssetCompressionStats(): AssetCompressionStats {
  return { compressions, hits, entries: cache.size, bytes: cachedBytes }
}

/** Test seam — the cache and its counters are process-wide. */
export function resetAssetCompressionCache(): void {
  cache.clear()
  inFlight.clear()
  compressions = 0
  hits = 0
  cachedBytes = 0
}
