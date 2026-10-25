/**
 * The Fastify + WebSocket glue for the D707 origin allowlist. The decision
 * itself is `cors-policy.ts`; this file applies it at the hub's two edges:
 *
 *  - every HTTP request (`onRequest`), INCLUDING the replies that bypass
 *    Fastify's pipeline: the addon data-plane reverse proxy `hijack()`s the
 *    socket, so the CORS headers are also stamped on `reply.raw`, where the
 *    proxy's `writeHead` merges them (and `proxyToUpstream` drops whatever
 *    CORS the upstream sent — the edge owns the policy);
 *  - the `/trpc` WebSocket upgrade, which CORS does not cover at all: a
 *    browser opens a socket to any origin and only sends `Origin`, so the
 *    server must refuse a foreign one itself.
 *
 * A denied origin gets NO CORS headers (the browser withholds the response
 * from the page) and is logged once per origin per process, so an operator who
 * hosts the viewer somewhere new can see why it is refused.
 */
import type { IncomingHttpHeaders } from 'node:http'
import type { Duplex } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import {
  appendVary,
  builtInOrigins,
  type CorsVerdict,
  corsResponseHeaders,
  judgeCorsOrigin,
  parseConfiguredOrigins,
} from './cors-policy.js'

/** The logger surface the policy needs (an `IScopedLogger` satisfies it). */
export interface CorsPolicyLogger {
  warn(message: string, options?: { meta?: Record<string, unknown> }): void
}

export interface CorsPolicyDeps {
  /**
   * The operator's extra origins — `ConfigService.get('server.corsOrigins')`.
   * Read per request and memoised by reference, so a `ConfigManager.update`
   * applies without a restart and an unchanged list costs one comparison.
   */
  readonly configuredOrigins: () => unknown
  readonly logger: CorsPolicyLogger
}

export interface CorsPolicy {
  judge(headers: IncomingHttpHeaders): CorsVerdict
}

/** Distinct refused origins remembered for log de-duplication. */
const MAX_LOGGED_DENIALS = 256

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function varyText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(', ')
  return undefined
}

export function createCorsPolicy(deps: CorsPolicyDeps): CorsPolicy {
  const builtIns = builtInOrigins()
  let lastConfigured: unknown = Symbol('unset')
  let listed: ReadonlySet<string> = new Set(builtIns)
  const loggedDenials = new Set<string>()

  const currentList = (): ReadonlySet<string> => {
    const configured = deps.configuredOrigins()
    if (configured === lastConfigured) return listed
    lastConfigured = configured
    const parsed = parseConfiguredOrigins(configured)
    if (parsed.rejected.length > 0) {
      deps.logger.warn('cors: ignored configured origins that are not http(s) origins', {
        meta: { rejected: parsed.rejected, setting: 'server.corsOrigins' },
      })
    }
    listed = new Set([...builtIns, ...parsed.origins])
    return listed
  }

  return {
    judge(headers) {
      const verdict = judgeCorsOrigin(
        {
          origin: headerValue(headers.origin),
          host: headerValue(headers.host),
          forwardedHost: headerValue(headers['x-forwarded-host']),
        },
        currentList(),
      )
      if (verdict.kind === 'denied' && !loggedDenials.has(verdict.origin)) {
        if (loggedDenials.size < MAX_LOGGED_DENIALS) loggedDenials.add(verdict.origin)
        deps.logger.warn('cors: refused a cross-origin caller not on the allowlist', {
          meta: {
            origin: verdict.origin,
            host: headerValue(headers.host) ?? null,
            hint: 'add it to server.corsOrigins (config.yaml) or CAMSTACK_CORS_ORIGINS',
          },
        })
      }
      return verdict
    },
  }
}

/**
 * Install the policy on the hub's Fastify instance. Every `OPTIONS` is
 * answered here with 204 (as before D707) — with grants only for an allowed
 * origin, so a refused preflight fails in the browser.
 */
export function registerCorsPolicy(fastify: FastifyInstance, policy: CorsPolicy): void {
  fastify.addHook('onRequest', async (request, reply) => {
    // The answer depends on Origin for every route, so every response says so
    // — a cached same-origin answer must never be replayed to another origin.
    const vary = appendVary(varyText(reply.getHeader('vary')), 'Origin')
    reply.header('vary', vary)
    reply.raw.setHeader('vary', vary)

    const verdict = policy.judge(request.headers)
    const isPreflight =
      request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined
    if (verdict.kind === 'allowed') {
      const headers = corsResponseHeaders(
        verdict.origin,
        isPreflight
          ? {
              requestPrivateNetwork:
                headerValue(request.headers['access-control-request-private-network']) === 'true',
            }
          : null,
      )
      for (const [name, value] of Object.entries(headers)) {
        reply.header(name, value)
        // Hijacked replies (the data-plane proxy) skip Fastify's header
        // write; Node merges these into their `writeHead`.
        reply.raw.setHeader(name, value)
      }
    }
    if (request.method === 'OPTIONS') {
      return reply.code(204).send()
    }
    return undefined
  })
}

/**
 * Refuse a WebSocket upgrade whose `Origin` is not on the allowlist. Returns
 * `true` when it refused (the socket is answered 403 and destroyed); the
 * caller must then do nothing else with it. A request with no `Origin` (a
 * Node client, an agent) passes — Origin is the browser's signal, and auth is
 * the bearer in `connectionParams` either way.
 */
export function refuseForeignWsUpgrade(
  policy: CorsPolicy,
  headers: IncomingHttpHeaders,
  socket: Duplex,
): boolean {
  const verdict = policy.judge(headers)
  if (verdict.kind !== 'denied') return false
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  socket.destroy()
  return true
}
