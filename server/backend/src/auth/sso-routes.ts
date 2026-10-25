/**
 * The two browser-facing SSO routes, kept out of `main.ts`:
 *
 *  - `GET /api/auth/sso/finish?bridge=…` — swaps a verified, single-use,
 *    browser-bound login bridge for a session / challenge / link
 *    (`sso-finish.ts` holds the rules). Limited per REAL client address.
 *    Every answer clears the `SSO_STATE_COOKIE`: it binds exactly one finish.
 *  - `GET /api/auth/sso/finish-app?bridge=…` - the same bridge rules for a
 *    NATIVE APP sign-in (D858): no web session, a handoff code at the app's
 *    custom scheme (`sso-finish-app.ts`).
 *  - `GET /api/auth/browser-handoff?code=…` — a one-time code from
 *    `auth.createBrowserHandoff` opens the account page signed in (D801).
 */
import { SSO_STATE_COOKIE } from '@camstack/types'
import type { FastifyInstance } from 'fastify'
import { parseForwardedPrefix } from '../api/static/spa-mount.js'
import type { HandoffCodeService } from '../core/auth/handoff-code.service.js'
import type { AuthNetworkPolicy } from './auth-network-policy.js'
import { clientKeyFromRequest, type RateLimiter } from './auth-rate-limit.js'
import { browserHandoffLocation, ssoReturnLocation } from './native-return.js'
import type { MintedSession, SessionMinter } from './session-mint.js'
import { finishSsoLogin } from './sso-finish.js'
import { APP_CONFIRM_PARAM, APP_CONFIRM_PATH, appConfirmCookie } from './app-confirm-routes.js'
import type { AppConfirmations } from './app-confirmations.js'
import { finishSsoApp } from './sso-finish-app.js'
import { createSsoFinishDeps, type SsoFinishWiring } from './sso-finish-deps.js'

export interface SsoRoutesLogger {
  info?(message: string, options?: { meta?: Record<string, unknown> }): void
  error(message: string, options?: { meta?: Record<string, unknown> }): void
  warn(message: string, options?: { meta?: Record<string, unknown> }): void
}

export interface SsoRoutesDeps {
  readonly wiring: Omit<SsoFinishWiring, 'logFailure'>
  readonly network: AuthNetworkPolicy
  /** Per-client limiter shared with the IdP routes (30/min). */
  readonly limiter: RateLimiter
  readonly browserHandoffCodes: HandoffCodeService
  /** Parked "sign the app in?" confirmations - the code is minted at Continue (D858). */
  readonly confirmations: AppConfirmations
  readonly minter: SessionMinter
  readonly logger: SsoRoutesLogger
}

/** A User-Agent as a session's client label. */
function clientOf(ua: string | string[] | undefined): { client?: string } {
  const value = Array.isArray(ua) ? ua[0] : ua
  return typeof value === 'string' && value.length > 0 ? { client: value.slice(0, 200) } : {}
}

/** Expire the state cookie (both Secure variants are cleared by name + path). */
function clearSsoStateCookie(): string {
  return `${SSO_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function registerSsoRoutes(fastify: FastifyInstance, deps: SsoRoutesDeps): void {
  fastify.get<{ Querystring: { bridge?: string; popup?: string } }>(
    '/api/auth/sso/finish',
    async (request, reply) => {
      const client = clientKeyFromRequest(request, deps.network)
      if (client !== null) {
        const verdict = deps.limiter.check(`sso-finish:${client}`)
        if (!verdict.allowed) {
          reply.header('retry-after', String(verdict.retryAfterSeconds))
          return reply.status(429).send({ error: 'Too many attempts' })
        }
      }
      const outcome = await finishSsoLogin(
        request.query.bridge,
        createSsoFinishDeps(
          {
            ...deps.wiring,
            sessionIssue: () => {
              const ip = deps.network.clientAddress(request).ip
              return { ...(ip !== null ? { ip } : {}), ...clientOf(request.headers['user-agent']) }
            },
            trustedNetworkLogin: () =>
              deps.network.isTrustedNetworkLogin(deps.network.clientAddress(request)),
            logFailure: (error) =>
              deps.logger.error('SSO finish failed', {
                meta: { error: error instanceof Error ? error.message : String(error) },
              }),
          },
          request.headers.cookie,
        ),
        // A popup sign-in (D791) returns through the admin-ui completion page.
        { popup: request.query.popup === '1' },
      )
      // One state cookie binds one finish, whatever the outcome.
      reply.header('Set-Cookie', clearSsoStateCookie())
      reply.header('Referrer-Policy', 'no-referrer')
      if (outcome.kind === 'error') return reply.status(outcome.status).send(outcome.body)
      reply.code(302)
      // Admin-ui paths are relative to the hub's mount (HA ingress etc.); a
      // native app return (`camstack://…`, D801) is not a hub path at all.
      const mount = parseForwardedPrefix(request.headers['x-forwarded-prefix']) ?? ''
      reply.header('Location', ssoReturnLocation(mount, outcome.location))
      return reply.send('')
    },
  )

  // The native-app leg (D858): same bridge rules, a handoff code instead of a
  // session. Every outcome - success or refusal - is a 302 to the app.
  fastify.get<{ Querystring: { bridge?: string } }>(
    '/api/auth/sso/finish-app',
    async (request, reply) => {
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('Cache-Control', 'no-store')
      const clearState = clearSsoStateCookie()
      reply.header('Set-Cookie', clearState)
      const client = clientKeyFromRequest(request, deps.network)
      if (client !== null) {
        const verdict = deps.limiter.check(`sso-finish:${client}`)
        if (!verdict.allowed) {
          reply.header('retry-after', String(verdict.retryAfterSeconds))
          return reply.status(429).send({ error: 'Too many attempts' })
        }
      }
      const outcome = await finishSsoApp(request.query.bridge, {
        ...createSsoFinishDeps(
          {
            ...deps.wiring,
            logFailure: (error) =>
              deps.logger.error('SSO app finish failed', {
                meta: { error: error instanceof Error ? error.message : String(error) },
              }),
          },
          request.headers.cookie,
        ),
        minter: deps.minter,
        confirmations: deps.confirmations,
        logRefusal: (error) => deps.logger.warn('SSO app finish refused', { meta: { error } }),
      })
      reply.code(302)
      if (outcome.kind === 'app') {
        reply.header('Location', outcome.location)
        return reply.send('')
      }
      // The confirmation page, on this hub (mount-aware); its cookie binds the
      // token to this browser. The SSO state cookie is spent either way.
      const mount = parseForwardedPrefix(request.headers['x-forwarded-prefix']) ?? ''
      reply.header('Set-Cookie', [
        clearState,
        appConfirmCookie(outcome.cookie, request.protocol === 'https'),
      ])
      reply.header(
        'Location',
        `${mount}${APP_CONFIRM_PATH}?${APP_CONFIRM_PARAM}=${encodeURIComponent(outcome.token)}`,
      )
      return reply.send('')
    },
  )

  // A one-time code minted by `auth.createBrowserHandoff` opens the account
  // page signed in (D801): the session rides the URL FRAGMENT (never a server
  // log), and the only destination is the account page.
  fastify.get<{ Querystring: { code?: string } }>(
    '/api/auth/browser-handoff',
    async (request, reply) => {
      const mount = parseForwardedPrefix(request.headers['x-forwarded-prefix']) ?? ''
      const grant =
        typeof request.query.code === 'string'
          ? deps.browserHandoffCodes.redeem(request.query.code)
          : null
      let session: MintedSession | null = null
      if (grant !== null) {
        try {
          // A session of its own for this browser (the admin-ui refreshes).
          const ip = deps.network.clientAddress(request).ip
          session = await deps.minter.mintForUserId(grant.userId, {
            method: 'handoff',
            refreshable: true,
            ...(grant.credentialId !== undefined ? { credentialId: grant.credentialId } : {}),
            ...(ip !== null ? { ip } : {}),
            ...clientOf(request.headers['user-agent']),
          })
        } catch (error: unknown) {
          deps.logger.warn('Browser handoff refused', {
            meta: { error: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      reply.code(302)
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('Location', browserHandoffLocation(mount, session))
      return reply.send('')
    },
  )
}
