/**
 * The agent's pairing HTTP surface (D857) - a thin mapping of `AgentPairing` results onto status
 * codes. These routes are reachable from the network in either state (see `isPairingProtocolRequest`);
 * each is authorized by what it carries, never by who calls:
 *
 *   GET  /api/agent/pairing/hello     who this agent is and whether it is paired
 *   POST /api/agent/pairing/offer     a hub offers its CA (rate limited per source)
 *   POST /api/agent/pairing/reveal    the hub reveals its nonce (by pairing id)
 *   POST /api/agent/pairing/poll      the hub asks whether the operator confirmed (by pairing id)
 *   POST /api/agent/pairing/cancel    the hub withdraws its pairing (by pairing id)
 *   POST /api/agent/pairing/complete  the hub's certificate + transcript proof (by pairing id)
 *   GET  /api/agent/pairing/status    who asks to pair, until when. From the network: nothing else.
 *                                     From this machine only: also the codes, PINs and pairing ids.
 *   POST /api/agent/pairing/confirm   the operator typed the hub's code - AND the one-time PIN printed on
 *                                     this machine, unless the request is genuinely local
 *   POST /api/agent/pairing/reject    the operator refuses (same PIN rule)
 *   POST /api/agent/pairing/reset     clear lockouts and pending offers: this machine, or the reset code
 *                                     printed at boot (console and pairing-reset.txt)
 *   POST /api/agent/pairing/forget    leave the hub (this machine, or a hub-unlocked session)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  PAIRING_PATHS,
  type AgentPairing,
  type PairingFailure,
  type PairingRequestContext,
  type PairingResult,
} from '@camstack/system'
import { authInputOf, isGenuineLoopback } from './agent-http-auth.js'

export interface AgentPairingRoutesDeps {
  readonly pairing: AgentPairing
  /** Leave the hub: erase the mesh material and reconnect unpaired. */
  readonly onForgetHub: () => Promise<void>
  readonly log: (message: string) => void
  /** Offers allowed per source address per minute (default 10). */
  readonly offersPerMinute?: number
  readonly now?: () => number
}

const OFFER_WINDOW_MS = 60_000
const DEFAULT_OFFERS_PER_MINUTE = 10
const MAX_TRACKED_SOURCES = 512

/** True for a request from this machine itself: loopback peer, no forwarding header. */
export function isLocalRequest(req: FastifyRequest): boolean {
  return isGenuineLoopback(authInputOf(req))
}

function send<T extends object>(reply: FastifyReply, result: PairingResult<T>): unknown {
  if (result.ok) return result
  const failure: PairingFailure = result
  if (failure.retryAfterMs !== undefined) {
    void reply.header('retry-after', String(Math.ceil(failure.retryAfterMs / 1000)))
  }
  return reply.status(failure.status).send({
    ok: false,
    error: failure.error,
    message: failure.message,
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
  })
}

export function registerAgentPairingRoutes(
  app: FastifyInstance,
  deps: AgentPairingRoutesDeps,
): void {
  const { pairing } = deps
  const now = deps.now ?? Date.now
  const limit = deps.offersPerMinute ?? DEFAULT_OFFERS_PER_MINUTE
  const offersBySource = new Map<string, number[]>()

  /** At most `limit` offers per source per minute, counted before the offer is even parsed. */
  const rateLimited = (source: string): boolean => {
    const at = now()
    const recent = (offersBySource.get(source) ?? []).filter((t) => at - t < OFFER_WINDOW_MS)
    if (offersBySource.size >= MAX_TRACKED_SOURCES && !offersBySource.has(source)) {
      offersBySource.clear()
    }
    if (recent.length >= limit) {
      offersBySource.set(source, recent)
      return true
    }
    offersBySource.set(source, [...recent, at])
    return false
  }

  app.get(PAIRING_PATHS.hello, async () => pairing.hello())

  // The network sees who asks; the agent's own machine sees the secrets.
  app.get(PAIRING_PATHS.status, async (req) =>
    isLocalRequest(req) ? pairing.localView() : pairing.publicView(),
  )

  app.post(PAIRING_PATHS.offer, async (req, reply) => {
    if (rateLimited(req.socket.remoteAddress ?? 'unknown')) {
      deps.log(`pairing offers from ${req.socket.remoteAddress ?? 'unknown'} are rate limited`)
      return reply.status(429).header('retry-after', '60').send({
        ok: false,
        error: 'rate-limited',
        message: 'too many pairing offers from this address - wait a minute',
      })
    }
    return send(reply, await pairing.offer(req.body))
  })
  app.post(PAIRING_PATHS.reveal, async (req, reply) => send(reply, pairing.reveal(req.body)))
  app.post(PAIRING_PATHS.poll, async (req, reply) => send(reply, pairing.poll(req.body)))
  app.post(PAIRING_PATHS.cancel, async (req, reply) => send(reply, pairing.cancel(req.body)))
  app.post(PAIRING_PATHS.complete, async (req, reply) =>
    send(reply, await pairing.complete(req.body)),
  )
  const contextOf = (req: FastifyRequest): PairingRequestContext => ({
    local: isLocalRequest(req),
    source: req.socket.remoteAddress ?? 'unknown',
  })
  app.post(PAIRING_PATHS.confirm, async (req, reply) =>
    send(reply, pairing.confirm(req.body, contextOf(req))),
  )
  app.post(PAIRING_PATHS.reject, async (req, reply) =>
    send(reply, pairing.reject(req.body, contextOf(req))),
  )
  // Clears the offer lockouts and pending offers: this machine, or the reset code printed at boot.
  app.post(PAIRING_PATHS.reset, async (req, reply) =>
    send(reply, pairing.reset(req.body, contextOf(req))),
  )

  // Authenticated by the onRequest hook (not a protocol path): this machine or a hub session.
  app.post(PAIRING_PATHS.forget, async (_req, reply) => {
    if (pairing.state() !== 'paired') {
      return reply
        .status(409)
        .send({ ok: false, error: 'not-paired', message: 'this agent is not paired' })
    }
    deps.log('Forgetting the hub on request (agent UI or local call)')
    await deps.onForgetHub()
    return { ok: true }
  })
}
