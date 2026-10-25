/**
 * A ready-made data-plane request handler that serves files from a set of roots
 * with HTTP `Range`, for addons whose data-plane is "stream files off disk"
 * (recording playback, scrub-frame stores, exported clips).
 *
 * This is the addon-side handler the addon hands to `ctx.dataPlane.serve({ handler })`.
 * It receives the REAL Node `req`/`res`, resolves the request path against the
 * addon's roots (traversal-guarded), and streams the file. NO token and NO CORS:
 * the hub already authenticated the caller and the data plane is same-origin
 * through the hub's port. Reuses the shared Range/content-type/traversal helpers
 * so there is one implementation across the standalone file-server and this.
 *
 * It also owns its own CONTENT-CODING. The hub bridge is `{ compress: false }`
 * because the global compressor emits an empty brotli stream over the forked-
 * addon route bridge, so nothing above this layer will ever compress an addon
 * body — see `asset-compression.ts` for the incident and the contract.
 */
import { createReadStream, promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  COMPRESSION_MIN_BYTES,
  getCompressedAsset,
  isCompressibleContentType,
  negotiateContentEncoding,
} from './asset-compression.js'
import { contentTypeFor, parseRangeHeader, resolveFilePath } from './authenticated-file-server.js'

export interface FileDataPlaneOptions {
  /** Current set of root dirs searched for a requested rel path (multi-location).
   *  Invoked per request so it always reflects live config. */
  readonly getRoots: () => readonly string[]
  /** Optional extension→content-type overrides merged over the media defaults. */
  readonly contentTypes?: Readonly<Record<string, string>>
  /**
   * Optional per-path Cache-Control resolver. Return a header value to use for
   * this rel path, or undefined for the default (`no-cache`). Lets a caller
   * serve content-hashed bundle assets as `public, max-age=…, immutable`
   * (re-downloading a 1MB SPA bundle on every open is a real cold-start cost)
   * while entry HTML stays revalidated.
   */
  readonly cacheControl?: (rel: string) => string | undefined
}

/** Build a `(req, res)` handler that serves `getRoots()` files with Range. */
export function createFileDataPlaneHandler(
  opts: FileDataPlaneOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }

    const urlPath = (req.url ?? '/').split('?')[0] ?? '/'
    let rel: string
    try {
      rel = decodeURIComponent(urlPath.replace(/^\/+/, ''))
    } catch {
      res.writeHead(400).end()
      return
    }
    if (rel.length === 0) {
      res.writeHead(404).end()
      return
    }

    const resolved = resolveFilePath(opts.getRoots(), rel)
    if ('error' in resolved) {
      res.writeHead(403).end()
      return
    }

    let absPath: string | null = null
    let size = 0
    let mtimeMs = 0
    for (const candidate of resolved.candidates) {
      try {
        const st = await fs.stat(candidate)
        if (st.isFile()) {
          absPath = candidate
          size = st.size
          mtimeMs = st.mtimeMs
          break
        }
      } catch {
        // not in this root — try the next
      }
    }
    if (absPath === null) {
      res.writeHead(404).end()
      return
    }

    const contentType = contentTypeFor(absPath, opts.contentTypes)
    const compressible = isCompressibleContentType(contentType)
    const baseHeaders: Record<string, string> = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'cache-control': opts.cacheControl?.(rel) ?? 'no-cache',
      // Stamped on EVERY response for a compressible asset, not just the
      // compressed ones: a shared cache that stored the identity body without
      // this would hand it to a client that asked for `br`, and vice versa.
      ...(compressible ? { vary: 'accept-encoding' } : {}),
    }
    const range = parseRangeHeader(req.headers.range, size)
    if (range) {
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1),
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(absPath, { start: range.start, end: range.end }).pipe(res)
      return
    }
    // Whole-body path: negotiate a content-coding. A Range request never gets
    // here — a partial body is expressed in IDENTITY offsets, so `bytes a-b` of
    // a compressed stream would be meaningless to the client that asked for it.
    const encoding = compressible ? negotiateContentEncoding(req.headers['accept-encoding']) : null
    if (encoding !== null && size >= COMPRESSION_MIN_BYTES) {
      const filePath = absPath
      const body = await getCompressedAsset({ path: filePath, mtimeMs, size, encoding }, () =>
        fs.readFile(filePath),
      )
      if (body !== null) {
        res.writeHead(200, {
          ...baseHeaders,
          'content-encoding': encoding,
          // A byte range into a coded body is not the range the client means, so
          // do not advertise one for this representation.
          'accept-ranges': 'none',
          'content-length': String(body.byteLength),
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(body)
        return
      }
    }

    res.writeHead(200, { ...baseHeaders, 'content-length': String(size) })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(absPath).pipe(res)
  }
}
