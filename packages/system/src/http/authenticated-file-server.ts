/**
 * Authenticated data-plane file-server — a shared host primitive for addons that
 * must serve files (media segments, scrub-frame stores, exported clips) directly
 * to browsers/players, node-direct (NOT through the hub tRPC, per the recording
 * design's "no media bytes traverse the hub").
 *
 * It bundles the three things every such server needs so addons don't re-roll
 * them: CORS (the data plane is cross-origin from the admin-ui — a native
 * `<video src>` is exempt but hls.js / WebCodecs fetch via XHR and are blocked
 * without it), HTTP `Range` (seeking / partial fetch), and a SCOPED TOKEN check.
 *
 * The token rides as the FIRST path segment (`<urlPrefix><token>/<relPath>`) so
 * a player resolving a manifest's RELATIVE child URIs carries it on every
 * sub-request automatically — no per-URI rewriting, no cookies/headers a dumb
 * player can't set. The caller supplies `verifyToken(token, relPath)`; the
 * primitive stays auth-scheme-agnostic.
 *
 * Pure helpers (`parseTokenizedUrl`, `resolveFilePath`, `contentTypeFor`,
 * `parseRangeHeader`) are exported for unit testing; `createAuthenticatedFileServer`
 * is the thin `node:http` glue.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'

/** Does `token` grant access to `relPath`? Supplied by the caller. */
export type FileServerTokenVerifier = (token: string, relPath: string) => boolean

export interface AuthenticatedFileServerOptions {
  /** URL namespace prefix, e.g. `/rec/`. Requests are `<urlPrefix><token>/<rel>`. */
  readonly urlPrefix: string
  /** Port to listen on (`0` = ephemeral). */
  readonly port: number
  /** Current set of root dirs to search for a requested rel path (multi-location). */
  readonly getRoots: () => readonly string[]
  /** Validate the per-request scoped token against the requested rel path. */
  readonly verifyToken: FileServerTokenVerifier
  /** `Access-Control-Allow-Origin` value. Default `*` (auth is the token, not the origin). */
  readonly corsOrigin?: string
  /** Optional extension→content-type overrides merged over the media defaults. */
  readonly contentTypes?: Readonly<Record<string, string>>
}

export interface FileServerHandle {
  readonly port: number
  close(): Promise<void>
}

export type FileResolveResult = { candidates: string[] } | { error: 'forbidden' }

function corsHeaders(origin: string): Record<string, string> {
  // Auth is the scoped path token, not the origin, so `*` is safe (no
  // cookies/credentials). `Range` must be an allowed request header and the
  // range headers exposed so the player can seek.
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range',
    'access-control-expose-headers': 'content-length, content-range, accept-ranges',
    'access-control-max-age': '86400',
  }
}

/**
 * Split a request URL (`<urlPrefix><token>/<relPath>`) into its token + rel
 * path. Returns null for anything outside the prefix or missing either part.
 * `relPath` is URL-decoded; a decode failure → null.
 */
export function parseTokenizedUrl(
  urlPrefix: string,
  urlPath: string,
): { token: string; rel: string } | null {
  if (!urlPath.startsWith(urlPrefix)) return null
  const after = urlPath.slice(urlPrefix.length)
  const slash = after.indexOf('/')
  if (slash <= 0) return null
  const token = after.slice(0, slash)
  let rel: string
  try {
    rel = decodeURIComponent(after.slice(slash + 1))
  } catch {
    return null
  }
  if (rel.length === 0) return null
  return { token, rel }
}

/**
 * Map a rel path to one candidate absolute path PER root, keeping only roots the
 * path stays within (traversal guard). The handler serves the first candidate
 * that exists. Rejects a path that escapes every root.
 */
export function resolveFilePath(roots: readonly string[], rel: string): FileResolveResult {
  if (rel.length === 0) return { error: 'forbidden' }
  const candidates: string[] = []
  for (const rootDir of roots) {
    const root = path.resolve(rootDir)
    const abs = path.resolve(root, rel)
    if (abs === root || abs.startsWith(root + path.sep)) candidates.push(abs)
  }
  if (candidates.length === 0) return { error: 'forbidden' }
  return { candidates }
}

const DEFAULT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  // Media (recording playback, clips, scrub stores).
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/mp4',
  '.mp4': 'video/mp4',
  '.idx': 'application/octet-stream',
  // Web/SPA bundles served off a data-plane (e.g. the stream-broker embed).
  // Without these, `.html`/`.js`/`.css` fall back to `application/octet-stream`
  // and a browser DOWNLOADS them instead of rendering. Consumers can still
  // override per-handler via `contentTypes`.
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

export function contentTypeFor(
  filePath: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  const ext = path.extname(filePath).toLowerCase()
  return overrides?.[ext] ?? DEFAULT_CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

export interface ByteRange {
  start: number
  end: number
}

/** Parse an HTTP `Range` header against a known size. Null = serve whole file. */
export function parseRangeHeader(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    const n = Number(rawEnd)
    if (n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Start an authenticated file-server. Returns the bound port so the caller can
 * build URLs. `getRoots`/`verifyToken` are invoked per request, so they always
 * reflect the live config.
 */
export async function createAuthenticatedFileServer(
  opts: AuthenticatedFileServerOptions,
): Promise<FileServerHandle> {
  const cors = corsHeaders(opts.corsOrigin ?? '*')
  const server = createServer((req, res) => {
    void handle(opts, cors, req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, () => resolve())
  })
  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port
  return {
    port: boundPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function handle(
  opts: AuthenticatedFileServerOptions,
  cors: Record<string, string>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // CORS preflight before auth (the OPTIONS request carries no token).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, cors).end()
    return
  }

  const urlPath = (req.url ?? '').split('?')[0] ?? ''
  const parsed = parseTokenizedUrl(opts.urlPrefix, urlPath)
  if (!parsed) {
    res.writeHead(403, cors).end()
    return
  }
  if (!opts.verifyToken(parsed.token, parsed.rel)) {
    res.writeHead(401, cors).end()
    return
  }

  const resolved = resolveFilePath(opts.getRoots(), parsed.rel)
  if ('error' in resolved) {
    res.writeHead(403, cors).end()
    return
  }

  let absPath: string | null = null
  let size = 0
  for (const candidate of resolved.candidates) {
    try {
      const st = await fs.stat(candidate)
      if (st.isFile()) {
        absPath = candidate
        size = st.size
        break
      }
    } catch {
      // not in this root — try the next
    }
  }
  if (absPath === null) {
    res.writeHead(404, cors).end()
    return
  }

  const baseHeaders: Record<string, string> = {
    ...cors,
    'content-type': contentTypeFor(absPath, opts.contentTypes),
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
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
  res.writeHead(200, { ...baseHeaders, 'content-length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(absPath).pipe(res)
}
