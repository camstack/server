/**
 * `GET /api/embed-auth?next=<embed-path>` — establish the browser session
 * cookie from a Bearer token, then 302 to the embed.
 *
 * A native WebView can pass `Authorization` only on the INITIAL navigation,
 * not on the page's asset sub-requests; the data-plane `authenticated` gate
 * reads the cookie, so the cookie is minted here (mirroring
 * `POST /api/auth/session`) and the browser bounces to the embed — page and
 * assets then authenticate through the cookie. `next` is restricted to the
 * stream-broker embed prefix (no open redirect).
 *
 * The bearer must be a person's LOGIN session naming a user that still
 * exists: the cookie it becomes is a session everywhere a cookie is read (the
 * OAuth consent page among them). A minted token — a share link above all —
 * is refused, as is a bridge or challenge token (security review 2026-10-21).
 */
import type { FastifyInstance } from 'fastify'
import { FORWARDED_PREFIX_HEADER } from '../api/static/spa-mount.js'
import {
  buildSessionCookie,
  isEmbedRedirectTarget,
  isSessionGradeJwtPayload,
  sessionCookieIsSecure,
} from './session-cookie.js'

export interface EmbedAuthRouteDeps {
  /** The hub's raw session-family verify (refuses a minted token, D895). Throws when invalid. */
  readonly verifyToken: (token: string) => unknown
  readonly isLiveUser: (userId: string) => Promise<boolean>
}

/** Seconds the cookie may live for `payload`, or `null` when it is not a live person's session. */
async function sessionCookieTtl(deps: EmbedAuthRouteDeps, token: string): Promise<number | null> {
  let payload: unknown
  try {
    payload = deps.verifyToken(token)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null || !isSessionGradeJwtPayload(payload)) {
    return null
  }
  const userId: unknown = Reflect.get(payload, 'userId')
  if (typeof userId !== 'string' || !(await deps.isLiveUser(userId))) return null
  const exp: unknown = Reflect.get(payload, 'exp')
  const expSec = typeof exp === 'number' ? exp : 0
  return Math.max(0, expSec - Math.floor(Date.now() / 1000))
}

export function registerEmbedAuthRoute(fastify: FastifyInstance, deps: EmbedAuthRouteDeps): void {
  fastify.get<{ Querystring: { next?: string } }>('/api/embed-auth', async (request, reply) => {
    const authHeader = request.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined
    if (!token) return reply.status(401).send({ error: 'Bearer token required' })
    const next = request.query?.next ?? ''
    if (!isEmbedRedirectTarget(next)) return reply.status(400).send({ error: 'invalid next' })
    const ttlSec = await sessionCookieTtl(deps, token)
    if (ttlSec === null) return reply.status(401).send({ error: 'invalid token' })
    const c = buildSessionCookie(token, ttlSec, {
      secure: sessionCookieIsSecure(request.protocol, request.headers, FORWARDED_PREFIX_HEADER),
    })
    reply.setCookie(c.name, c.value, c.options)
    return reply.redirect(next)
  })
}
