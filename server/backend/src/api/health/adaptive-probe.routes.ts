/**
 * Burst blob for adaptive-tier downlink measurement (D635).
 *
 * Size: 1 MiB. The client times the body from its FIRST byte and decides
 * against 2.5 Mbps (`mid`) and 8 Mbps (`high`). At 8 Mbps, 1 MiB is ~1.05 s of
 * transfer, so a 16 ms WebView timer tick is ~1.5 % of the reading and a WAN
 * slow start (~3 RTTs at 50 ms) is ~15 %; the previous 128 KiB was 131 ms at
 * the same rate — a single timer tick was 12 % of it, and timed from the
 * request on a busy hub it measured latency (1.2–1.46 Mbps on a LAN).
 *
 * Cost, including cellular: one probe per camera app-wide per 30 s cache
 * window (the client single-flights it), cut by the client's 2.5 s deadline —
 * at most ~0.8 MB at 2.5 Mbps, 1 MiB on anything faster. That is about three
 * minutes of a 41 kbps sub stream per camera OPEN, not per minute of viewing;
 * renegotiations reuse the cached value and never probe.
 *
 * Access (round 3, review I6): a 100-byte request that returns 1 MiB is an
 * amplifier, and the hub is reachable through relays. The route therefore
 * requires a SESSION — Bearer JWT or the session cookie, the same session-grade
 * check the stream data plane applies — and is rate-limited per client IP.
 * Everything a refusal returns is a few bytes.
 */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { isAuthorizedHealthRequest } from './health.routes.js'
import type { AuthNetworkPolicy } from '../../auth/auth-network-policy.js'
import { clientKeyFromRequest, type RateLimiter } from '../../auth/auth-rate-limit.js'

export const ADAPTIVE_PROBE_BYTES = 1024 * 1024

/**
 * Probes a client IP may draw per minute: 12. The client probes at most once
 * per 30 s per app (single-flight + cache), so 12 leaves room for several
 * apps/devices behind one NAT and caps an abuser at 12 MiB/min.
 */
export const ADAPTIVE_PROBE_PER_IP_PER_MINUTE = 12

/**
 * Random, so it is INCOMPRESSIBLE. The previous body was one repeated byte and
 * `@fastify/compress` (global in `main.ts`; its default types include
 * `octet-stream`) gzipped it to a few hundred bytes — the client timed a round
 * trip and called it bandwidth. `compress: false` below stops our own
 * compressor; randomness also defeats one in a relay on the way.
 */
const BODY = randomBytes(ADAPTIVE_PROBE_BYTES)

export interface AdaptiveProbeRouteDeps {
  /** `AuthService.verifyToken` — throws on an invalid/expired token. */
  readonly verifyToken: (token: string) => unknown
  readonly limiter: RateLimiter
  /** Real client address behind a trusted proxy; default trusts loopback only. */
  readonly network?: AuthNetworkPolicy
}

export function registerAdaptiveProbeRoute(
  fastify: FastifyInstance,
  deps: AdaptiveProbeRouteDeps,
): void {
  fastify.get('/adaptive-probe', { compress: false }, async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const authorized = isAuthorizedHealthRequest(
      {
        ...(typeof req.headers.authorization === 'string'
          ? { authorization: req.headers.authorization }
          : {}),
        ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
      },
      deps.verifyToken,
    )
    if (!authorized) return reply.status(401).send({ ok: false, error: 'unauthorized' })
    const key = clientKeyFromRequest(req, deps.network)
    if (key !== null) {
      const verdict = deps.limiter.check(`adaptive-probe:${key}`)
      if (!verdict.allowed) {
        reply.header('retry-after', String(verdict.retryAfterSeconds))
        return reply.status(429).send({ ok: false, error: 'rate limited' })
      }
    }
    reply.header('content-type', 'application/octet-stream')
    return reply.send(BODY)
  })
}
