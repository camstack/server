/**
 * Vendor login proxy (D955) — sign in to a vendor whose login has no third-party
 * OAuth callback by opening the vendor's own login page THROUGH the hub.
 *
 * Mounted as an addon data plane (`/addon/<addonId>/vendor-login/…`), so the hub
 * authenticates the browser (admin session) and pipes; this module produces the
 * bytes. A request is `/<attemptId>/<vendorHost>/<path>`:
 *
 *  - the attempt id is a random one-shot capability opened by the addon, expiring
 *    with it, consumed when the terminal condition fires;
 *  - the vendor host must be in the attempt's allow-list (an open proxy would be an
 *    SSRF), and `http` is accepted for a loopback host only;
 *  - responses are rewritten so the vendor's absolute URLs, `Location` and
 *    `Set-Cookie` stay inside the proxy, and the framing/CSP/HSTS headers that would
 *    stop the page working under a different origin are dropped;
 *  - the TERMINAL condition is a function the addon provides: for each upstream
 *    response it answers `continue` or `done(payload)`; on `done` the addon's
 *    `onDone` finishes the sign-in and the browser is redirected to the CamStack
 *    result page (`oauthLandingUrl`) with a status and a reason code — never a token.
 *
 * Nothing here logs a request or response body, a cookie, an Authorization value,
 * a Location or the payload.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler } from '../interfaces/addon-data-plane.js'
import type { IScopedLogger } from '../interfaces/logging.js'
import { VENDOR_LOGIN_PROXY_PREFIX } from './prefix.js'
import { oauthLandingUrl, type OauthLandingOutcome } from '../utils/oauth-landing.js'
import {
  filterForwardedCookies,
  findUpstream,
  isValidUpstream,
  parseProxyPath,
  rewriteBody,
  rewriteLocation,
  rewriteReferer,
  rewriteFormBody,
  rewriteSetCookie,
  upstreamUrlFor,
  type BodyKind,
  type LoginProxyRoute,
  type LoginProxyUpstream,
} from './url-rewrite.js'

/** What the terminal function sees of one upstream response. Never logged. */
export interface LoginProxyResponseView {
  readonly status: number
  /** The vendor URL that was requested. */
  readonly url: string
  /** The raw `Location` the vendor sent (a custom app scheme is visible here), or null. */
  readonly location: string | null
  readonly setCookies: readonly string[]
  /** The body when it is small text (HTML/JSON/JS), else null. */
  readonly bodyText: string | null
}

export type LoginProxyVerdict<T> =
  | { readonly kind: 'continue' }
  | { readonly kind: 'done'; readonly payload: T }

export interface LoginProxyAttemptSpec<T> {
  /** The attempt id the addon already minted (a sign-in attempt id); the path capability. */
  readonly attemptId: string
  readonly expiresAtMs: number
  readonly upstreams: readonly LoginProxyUpstream[]
  /** Called for every upstream response of this attempt. */
  readonly terminal: (
    view: LoginProxyResponseView,
  ) => LoginProxyVerdict<T> | Promise<LoginProxyVerdict<T>>
  /** Finish the sign-in with the payload; the outcome picks the result page the browser lands on. */
  readonly onDone: (payload: T) => Promise<OauthLandingOutcome>
}

export interface VendorLoginProxyOptions {
  readonly addonId: string
  readonly logger: IScopedLogger
  readonly now?: () => number
  /** Injectable for tests; defaults to the platform `fetch`. */
  readonly fetchFn?: typeof fetch
}

type Settled =
  | { readonly kind: 'continue' }
  | { readonly kind: 'done'; readonly landing: OauthLandingOutcome }

interface OpenAttempt {
  readonly expiresAtMs: number
  readonly upstreams: readonly LoginProxyUpstream[]
  readonly evaluate: (view: LoginProxyResponseView) => Promise<Settled>
}

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
const MAX_TEXT_BODY_BYTES = 4 * 1024 * 1024

/** Request headers that are never forwarded to the vendor. */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'authorization',
  'cookie',
  'origin',
  'referer',
  'x-camstack-dataplane-secret',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-prefix',
  'x-real-ip',
  'forwarded',
])

/**
 * Response headers dropped: framing/CSP/HSTS that break a page under another origin, and
 * the ones that no longer describe the (decoded, possibly rewritten) body.
 */
const DROP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'public-key-pins',
  'report-to',
  'nel',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
  'location',
])

function bodyKindOf(contentType: string): BodyKind | null {
  const type = contentType.toLowerCase()
  if (type.includes('text/html') || type.includes('application/xhtml')) return 'html'
  if (type.includes('text/css')) return 'css'
  if (
    type.startsWith('text/') ||
    type.includes('javascript') ||
    type.includes('json') ||
    type.includes('xml')
  )
    return 'other'
  return null
}

function isFormEncoded(contentType: string | string[] | undefined): boolean {
  return (firstHeader(contentType) ?? '')
    .toLowerCase()
    .startsWith('application/x-www-form-urlencoded')
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_REQUEST_BODY_BYTES) return 'too-large'
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

export class VendorLoginProxy {
  readonly #addonId: string
  readonly #logger: IScopedLogger
  readonly #now: () => number
  readonly #fetch: typeof fetch
  readonly #attempts = new Map<string, OpenAttempt>()

  constructor(options: VendorLoginProxyOptions) {
    this.#addonId = options.addonId
    this.#logger = options.logger
    this.#now = options.now ?? (() => Date.now())
    this.#fetch = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  /** The `DataPlaneHandler` to pass to `ctx.dataPlane.serve({ prefix: VENDOR_LOGIN_PROXY_PREFIX, access: 'admin', … })`. */
  readonly handler: DataPlaneHandler = (req, res) => this.#handle(req, res)

  /** Register an attempt. A one-shot capability: refused hosts are rejected up front. */
  open<T>(spec: LoginProxyAttemptSpec<T>): void {
    for (const upstream of spec.upstreams) {
      if (!isValidUpstream(upstream)) {
        throw new Error(`vendor login proxy: upstream ${upstream.host} is not allowed`)
      }
    }
    this.#attempts.set(spec.attemptId, {
      expiresAtMs: spec.expiresAtMs,
      upstreams: spec.upstreams,
      evaluate: async (view) => {
        const verdict = await spec.terminal(view)
        if (verdict.kind === 'continue') return verdict
        return { kind: 'done', landing: await spec.onDone(verdict.payload) }
      },
    })
  }

  close(attemptId: string): void {
    this.#attempts.delete(attemptId)
  }

  isOpen(attemptId: string): boolean {
    const attempt = this.#attempts.get(attemptId)
    return attempt !== undefined && this.#now() <= attempt.expiresAtMs
  }

  /**
   * The hub-relative path that opens `vendorUrl` through the proxy for this attempt:
   * the URL the browser is sent to. Null when the host is not in the attempt's list.
   */
  entryPath(attemptId: string, vendorUrl: string): string | null {
    const attempt = this.#attempts.get(attemptId)
    if (attempt === undefined) return null
    const url = new URL(vendorUrl)
    if (findUpstream({ basePath: '', upstreams: attempt.upstreams }, url.host) === undefined) {
      return null
    }
    return `/addon/${this.#addonId}/${VENDOR_LOGIN_PROXY_PREFIX}/${attemptId}/${url.host}${url.pathname}${url.search}`
  }

  #routeFor(attemptId: string, attempt: OpenAttempt, forwardedPrefix: string): LoginProxyRoute {
    return {
      basePath: `${forwardedPrefix}/addon/${this.#addonId}/${VENDOR_LOGIN_PROXY_PREFIX}/${attemptId}`,
      upstreams: attempt.upstreams,
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.#serve(req, res)
    } catch (err: unknown) {
      this.#logger.warn('vendor login proxy: request failed', {
        meta: { addonId: this.#addonId, error: err instanceof Error ? err.name : 'unknown' },
      })
      if (!res.headersSent) sendPlain(res, 502, 'The sign-in page could not be reached.')
      else res.end()
    }
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = parseProxyPath(req.url ?? '/')
    if (parsed === null) {
      sendPlain(res, 404, 'Not found')
      return
    }
    const forwardedPrefix = (firstHeader(req.headers['x-forwarded-prefix']) ?? '').replace(
      /\/+$/,
      '',
    )
    const attempt = this.#attempts.get(parsed.attemptId)
    if (attempt === undefined || this.#now() > attempt.expiresAtMs) {
      if (attempt !== undefined) this.#attempts.delete(parsed.attemptId)
      this.#logger.info('vendor login proxy: attempt refused', {
        meta: { addonId: this.#addonId, reason: attempt === undefined ? 'missing' : 'expired' },
      })
      this.#redirect(res, forwardedPrefix, {
        status: 'error',
        addonId: this.#addonId,
        reason: 'invalid_state',
      })
      return
    }
    const route = this.#routeFor(parsed.attemptId, attempt, forwardedPrefix)
    const upstream = findUpstream(route, parsed.host)
    const target = upstream === undefined ? null : upstreamUrlFor(upstream, parsed)
    if (upstream === undefined || target === null) {
      this.#logger.warn('vendor login proxy: host refused', {
        meta: { addonId: this.#addonId, host: parsed.host },
      })
      sendPlain(res, 404, 'Not found')
      return
    }

    const method = (req.method ?? 'GET').toUpperCase()
    let body: Buffer | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const read = await readRequestBody(req)
      if (read === 'too-large') {
        sendPlain(res, 413, 'Request too large')
        return
      }
      body = isFormEncoded(req.headers['content-type'])
        ? Buffer.from(rewriteFormBody(read.toString('utf8'), route), 'utf8')
        : read
    }

    const headers = this.#requestHeaders(req, route, upstream)
    const upstreamRes = await this.#fetch(target, {
      method,
      headers,
      redirect: 'manual',
      ...(body !== undefined && body.length > 0 ? { body: new Uint8Array(body) } : {}),
    })
    const location = upstreamRes.headers.get('location')
    const setCookies = upstreamRes.headers.getSetCookie()
    const contentType = upstreamRes.headers.get('content-type') ?? ''
    const kind = bodyKindOf(contentType)
    const declaredLength = Number(upstreamRes.headers.get('content-length') ?? '0')
    const bufferText = kind !== null && !(declaredLength > MAX_TEXT_BODY_BYTES) && method !== 'HEAD'
    const text = bufferText ? await upstreamRes.text() : null

    this.#logger.info('vendor login proxy: upstream answered', {
      meta: {
        addonId: this.#addonId,
        host: upstream.host,
        path: target.pathname,
        status: upstreamRes.status,
        method,
      },
    })

    const settled = await attempt.evaluate({
      status: upstreamRes.status,
      url: target.toString(),
      location,
      setCookies,
      bodyText: text,
    })
    if (settled.kind === 'done') {
      this.#attempts.delete(parsed.attemptId)
      this.#logger.info('vendor login proxy: sign-in finished', {
        meta: { addonId: this.#addonId, status: settled.landing.status },
      })
      this.#redirect(res, forwardedPrefix, settled.landing)
      return
    }

    const out: Record<string, string | string[]> = {}
    upstreamRes.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out[name] = value
    })
    if (setCookies.length > 0) out['set-cookie'] = setCookies.map((c) => rewriteSetCookie(c, route))
    if (location !== null) out['location'] = rewriteLocation(location, upstream, route)
    out['cache-control'] = 'no-store'

    if (text !== null && kind !== null) {
      const rewritten = rewriteBody(text, kind, upstream, route)
      res.writeHead(upstreamRes.status, out)
      res.end(rewritten)
      return
    }
    res.writeHead(upstreamRes.status, out)
    await this.#pipeBody(upstreamRes, res)
  }

  #requestHeaders(
    req: IncomingMessage,
    route: LoginProxyRoute,
    upstream: LoginProxyUpstream,
  ): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase()
      if (DROP_REQUEST_HEADERS.has(lower) || value === undefined) continue
      headers[lower] = Array.isArray(value) ? value.join(', ') : value
    }
    const cookie = filterForwardedCookies(firstHeader(req.headers['cookie']) ?? '')
    if (cookie.length > 0) headers['cookie'] = cookie
    if (req.headers['origin'] !== undefined) {
      headers['origin'] = `${upstream.scheme}://${upstream.host}`
    }
    const referer = firstHeader(req.headers['referer'])
    if (referer !== undefined) {
      const back = rewriteReferer(referer, route)
      if (back !== null) headers['referer'] = back
    }
    return headers
  }

  async #pipeBody(upstreamRes: Response, res: ServerResponse): Promise<void> {
    if (upstreamRes.body === null) {
      res.end()
      return
    }
    for await (const chunk of upstreamRes.body) {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          res.once('drain', resolve)
          res.once('close', resolve)
        })
      }
      if (res.destroyed) return
    }
    res.end()
  }

  #redirect(res: ServerResponse, forwardedPrefix: string, outcome: OauthLandingOutcome): void {
    res.writeHead(302, {
      location: `${forwardedPrefix}${oauthLandingUrl(null, outcome)}`,
      'cache-control': 'no-store',
    })
    res.end()
  }
}
