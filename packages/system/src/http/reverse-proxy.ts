/**
 * Transport-agnostic reverse-proxy from the hub to an addon's `127.0.0.1`
 * data-plane listener. Operates on RAW Node http objects (`request.raw` /
 * `reply.raw`) so `@camstack/system` stays free of any HTTP-framework dependency.
 *
 * The hub authenticates first (its existing scoped-token / admin / cookie logic),
 * then hands the raw request+response here. We forward method + headers (incl.
 * `Range`) + body upstream — injecting the per-listener shared secret so the addon
 * accepts the call — and pipe the upstream response straight back (status +
 * headers + body), so `Content-Range`, backpressure and client-disconnect are all
 * native. No bytes are buffered; nothing crosses the cap channel.
 */
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type OutgoingHttpHeaders,
} from 'node:http'
import { DATAPLANE_SECRET_HEADER } from '@camstack/types'

export interface ReverseProxyOptions {
  /** Addon listener base, e.g. `http://127.0.0.1:54123`. */
  readonly baseUrl: string
  /** Per-listener shared secret injected so the addon trusts the request. */
  readonly secret: string
  /** Upstream path INCLUDING any query string, leading-slashed (`/7/seg.m4s?x=1`). */
  readonly upstreamPath: string
  readonly clientReq: IncomingMessage
  readonly clientRes: ServerResponse
  /**
   * Body already consumed by the host HTTP framework. When present, replay it
   * explicitly instead of piping the now-ended raw request stream.
   */
  readonly replayBody?: Buffer
}

/**
 * The upstream's response headers, minus the CORS policy, which belongs to the
 * EDGE (D707). The hub stamps its allowlist verdict on `clientRes` with
 * `setHeader` before hijacking, and Node merges those into `writeHead` — so an
 * upstream `access-control-*` header would OVERRIDE the hub's answer: the
 * authenticated file-server's `*` reached a refused origin this way. `Vary` is
 * merged rather than replaced, so the edge's `Origin` survives an upstream
 * `Accept-Encoding`.
 */
export function edgeOwnedResponseHeaders(
  upRes: IncomingMessage,
  clientRes: ServerResponse,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(upRes.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower.startsWith('access-control-')) continue
    out[lower] = value
  }
  const edgeVary = clientRes.getHeader('vary')
  const upVary = out['vary']
  if (typeof edgeVary === 'string' && edgeVary.length > 0 && upVary !== undefined) {
    const tokens = new Set<string>()
    const merged: string[] = []
    for (const part of [edgeVary, String(upVary)].join(',').split(',')) {
      const token = part.trim()
      if (token.length === 0 || tokens.has(token.toLowerCase())) continue
      tokens.add(token.toLowerCase())
      merged.push(token)
    }
    out['vary'] = merged.join(', ')
  }
  return out
}

/** Reverse-proxy one request to an addon data-plane listener. Fire-and-forget:
 *  the caller must `reply.hijack()` (or otherwise stop the framework from also
 *  responding) before calling this, since we drive `clientRes` directly. */
export function proxyToUpstream(opts: ReverseProxyOptions): void {
  const { baseUrl, secret, upstreamPath, clientReq, clientRes, replayBody } = opts
  const base = new URL(baseUrl)

  const headers: OutgoingHttpHeaders = { ...clientReq.headers }
  // The upstream is a different host:port — drop the inbound Host and any
  // hop-by-hop framing we shouldn't replay, then stamp the trust secret.
  delete headers.host
  delete headers.connection
  delete headers['content-length']
  if (replayBody !== undefined) headers['content-length'] = replayBody.byteLength
  headers[DATAPLANE_SECRET_HEADER] = secret

  const upstream = httpRequest(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: clientReq.method ?? 'GET',
      path: upstreamPath,
      headers,
    },
    (upRes) => {
      clientRes.writeHead(upRes.statusCode ?? 502, edgeOwnedResponseHeaders(upRes, clientRes))
      upRes.pipe(clientRes)
    },
  )

  upstream.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' })
    }
    clientRes.end(JSON.stringify({ error: 'data-plane upstream error', detail: String(err) }))
  })

  // Tear the upstream down only if the CLIENT disconnects BEFORE we finish — so
  // we don't keep reading a file nobody is consuming. Tying this to the request
  // stream's `close` would fire immediately for an already-consumed GET and kill
  // the upstream before it responds ("socket hang up").
  clientRes.on('close', () => {
    if (!clientRes.writableFinished && !upstream.destroyed) upstream.destroy()
  })

  if (replayBody !== undefined) {
    upstream.end(replayBody)
  } else {
    // Forward streaming bodies that Fastify did not consume (media uploads,
    // GET/HEAD, and custom content types).
    clientReq.pipe(upstream)
  }
}
