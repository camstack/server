/**
 * The hub's membership routes (D857): the one HTTP answer a REFUSED agent can get.
 *
 *   POST /api/mesh/membership/challenge   -> { nonce }
 *   POST /api/mesh/membership             -> { token }   (a CA-signed answer: member | revoked | unknown)
 *
 * Unauthenticated by design - the caller has no session, its mesh connection is refused - and
 * authorized by what it carries: a signature, made with a leaf's private key, over the nonce. Anyone
 * else gets a bare status code and learns nothing. Rate limited per source address.
 */
import type { FastifyInstance } from 'fastify'
import {
  getProcessMeshCaState,
  getProcessMeshCertificateRegistry,
  MEMBERSHIP_PATHS,
  MembershipResponder,
  processMeshCrl,
} from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import { createRateLimiter } from '../auth/auth-rate-limit'

export interface MeshMembershipRoutesOptions {
  readonly logger: IScopedLogger
  /** Test seam; defaults to the process registry, CRL and mesh CA. */
  readonly responder?: MembershipResponder
  readonly now?: () => number
  /** Requests per source address per minute (default 60). */
  readonly perMinute?: number
}

const WINDOW_MS = 60_000
const DEFAULT_PER_MINUTE = 60

export function createProcessMembershipResponder(logger: IScopedLogger): MembershipResponder {
  return new MembershipResponder({
    registry: getProcessMeshCertificateRegistry,
    crl: processMeshCrl,
    caKeyPem: () => {
      const state = getProcessMeshCaState()
      return state.state === 'ready' ? state.ca.keyPem : null
    },
    log: (message, meta) => logger.warn(message, { tags: { nodeId: meta.nodeId } }),
  })
}

export function registerMeshMembershipRoutes(
  fastify: FastifyInstance,
  options: MeshMembershipRoutesOptions,
): void {
  const responder = options.responder ?? createProcessMembershipResponder(options.logger)
  const limiter = createRateLimiter({
    windowMs: WINDOW_MS,
    max: options.perMinute ?? DEFAULT_PER_MINUTE,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })

  fastify.post(MEMBERSHIP_PATHS.challenge, async (request, reply) => {
    const verdict = limiter.check(request.socket.remoteAddress ?? 'unknown')
    if (!verdict.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(verdict.retryAfterSeconds))
        .send({ ok: false })
    }
    return { nonce: responder.issueChallenge() }
  })

  fastify.post(MEMBERSHIP_PATHS.query, async (request, reply) => {
    const verdict = limiter.check(request.socket.remoteAddress ?? 'unknown')
    if (!verdict.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(verdict.retryAfterSeconds))
        .send({ ok: false })
    }
    const outcome = responder.answer(request.body)
    if (!outcome.ok) return reply.status(outcome.status).send({ ok: false })
    return { token: outcome.token }
  })
}
