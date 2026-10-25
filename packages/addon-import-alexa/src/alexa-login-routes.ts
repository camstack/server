import { z } from 'zod'
import { errMsg } from '@camstack/types'
import type {
  AddonHttpReply,
  AddonHttpRequest,
  IAddonHttpRoute,
  IScopedLogger,
} from '@camstack/types'
import type { AlexaProxyLoginManager } from './alexa-proxy-login-manager.js'
import { capturedToCookieString } from './alexa-proxy-login-manager.js'

/**
 * `addon-routes` control plane that drives the INTERACTIVE Amazon login from the
 * onboarding wizard. All routes are `admin` — they start a proxy server and
 * mutate broker credentials, so they require an admin session/scoped token (the
 * hub enforces this BEFORE the handler runs; see `main.ts` `/addon/:addonId/*`).
 *
 * Public URLs (hub reachable as `https://<hub>`):
 *   POST /addon/import-alexa/login/start    { amazonDomain }            → { sessionId, loginUrl }
 *   GET  /addon/import-alexa/login/status?sessionId=…                   → AlexaProxyLoginStatus (no secrets)
 *   POST /addon/import-alexa/login/commit    { sessionId, name, brokerId? } → { brokerId }
 *   POST /addon/import-alexa/login/cancel    { sessionId }              → { ok: true }
 *
 * The wizard flow: POST /login/start → render a "Login to Amazon" button linking
 * to `loginUrl` (opened in a new tab) → poll /login/status until
 * `phase === 'captured'` → POST /login/commit to persist the cookie onto a new
 * or existing broker → proceed to device discovery/adoption.
 */

/**
 * Allowlist of real Amazon regional domains that alexa-remote2 is known to
 * support. Using an enum (rather than a free-form string) prevents admin-only
 * SSRF by ensuring the value can never be set to an arbitrary host — alexa-remote2
 * uses it as a raw domain suffix (`alexa.${domain}`, `api.${domain}`, …).
 */
const AMAZON_DOMAINS = [
  'amazon.com',
  'amazon.it',
  'amazon.de',
  'amazon.co.uk',
  'amazon.fr',
  'amazon.es',
  'amazon.ca',
  'amazon.com.au',
  'amazon.co.jp',
  'amazon.in',
  'amazon.com.br',
  'amazon.com.mx',
] as const

const StartBodySchema = z.object({
  amazonDomain: z.enum(AMAZON_DOMAINS).default('amazon.com'),
})

const StatusQuerySchema = z.object({
  sessionId: z.string().min(1),
})

const CommitBodySchema = z.object({
  sessionId: z.string().min(1),
  /** Name for a NEW broker (when `brokerId` is omitted). */
  name: z.string().min(1).default('Alexa account'),
  /** Existing broker to RE-LINK; omit to create a fresh broker. */
  brokerId: z.string().min(1).optional(),
})

const CancelBodySchema = z.object({
  sessionId: z.string().min(1),
})

/** Hooks the routes need into the addon (broker create/update + manager). */
export interface AlexaLoginRouteDeps {
  readonly logger: IScopedLogger
  readonly proxyLogin: AlexaProxyLoginManager
  /**
   * Commit a captured cookie onto a broker. When `brokerId` is given the broker
   * is re-linked (credentials swapped); otherwise a new broker is created. The
   * `amazonDomain` is the region the login authenticated against. Returns the
   * resulting broker id.
   */
  readonly commitCookie: (input: {
    readonly cookie: string
    readonly amazonDomain: string
    readonly name: string
    readonly brokerId?: string
  }) => Promise<{ readonly brokerId: string }>
}

/** Parse a JSON body that may arrive as an object or a raw string. */
function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return Object.fromEntries(Object.entries(body))
  }
  if (typeof body === 'string' && body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed))
      }
    } catch {
      // fall through to empty record
    }
  }
  return {}
}

export function buildAlexaLoginRoutes(deps: AlexaLoginRouteDeps): readonly IAddonHttpRoute[] {
  const { logger, proxyLogin, commitCookie } = deps

  return [
    {
      method: 'POST',
      path: '/login/start',
      access: 'admin',
      description: 'Start the interactive Amazon proxy-login; returns the URL to open',
      handler: async (req: AddonHttpRequest, reply: AddonHttpReply) => {
        const parsed = StartBodySchema.safeParse(asRecord(req.body))
        if (!parsed.success) {
          reply.code(400).send({ error: 'invalid body', detail: parsed.error.message })
          return
        }
        try {
          const result = await proxyLogin.start(parsed.data.amazonDomain)
          reply.code(200).send(result)
        } catch (err: unknown) {
          logger.warn('alexa login/start failed', { meta: { error: errMsg(err) } })
          reply.code(500).send({ error: errMsg(err) })
        }
      },
    },
    {
      method: 'GET',
      path: '/login/status',
      access: 'admin',
      description: 'Poll the interactive login session status (no secrets returned)',
      handler: async (req: AddonHttpRequest, reply: AddonHttpReply) => {
        const parsed = StatusQuerySchema.safeParse(req.query)
        if (!parsed.success) {
          reply.code(400).send({ error: 'missing sessionId' })
          return
        }
        const status = proxyLogin.status(parsed.data.sessionId)
        if (status === null) {
          reply.code(404).send({ error: 'unknown or expired session' })
          return
        }
        reply.code(200).send(status)
      },
    },
    {
      method: 'POST',
      path: '/login/commit',
      access: 'admin',
      description: 'Persist the captured cookie onto a new or existing broker',
      handler: async (req: AddonHttpRequest, reply: AddonHttpReply) => {
        const parsed = CommitBodySchema.safeParse(asRecord(req.body))
        if (!parsed.success) {
          reply.code(400).send({ error: 'invalid body', detail: parsed.error.message })
          return
        }
        const { sessionId, name, brokerId } = parsed.data
        const status = proxyLogin.status(sessionId)
        const captured = proxyLogin.takeCaptured(sessionId)
        if (captured === null) {
          reply
            .code(409)
            .send({ error: 'no captured cookie for this session (login not completed yet?)' })
          return
        }
        const amazonDomain = status?.amazonDomain ?? 'amazon.com'
        try {
          const cookie = capturedToCookieString(captured)
          const result = await commitCookie({
            cookie,
            amazonDomain,
            name,
            ...(brokerId !== undefined ? { brokerId } : {}),
          })
          // Free the proxy/session now that we own the cookie.
          await proxyLogin.cancel(sessionId)
          reply.code(200).send(result)
        } catch (err: unknown) {
          logger.warn('alexa login/commit failed', { meta: { error: errMsg(err) } })
          reply.code(500).send({ error: errMsg(err) })
        }
      },
    },
    {
      method: 'POST',
      path: '/login/cancel',
      access: 'admin',
      description: 'Cancel an in-flight interactive login session',
      handler: async (req: AddonHttpRequest, reply: AddonHttpReply) => {
        const parsed = CancelBodySchema.safeParse(asRecord(req.body))
        if (!parsed.success) {
          reply.code(400).send({ error: 'missing sessionId' })
          return
        }
        await proxyLogin.cancel(parsed.data.sessionId)
        reply.code(200).send({ ok: true })
      },
    },
  ]
}
