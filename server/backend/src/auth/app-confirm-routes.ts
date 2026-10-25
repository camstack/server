/**
 * `/auth/app/confirm` - the last step of a native app sign-in (D858).
 *
 * Both browser legs (the OIDC `finish-app`, the passkey `finish`) end here
 * instead of at the app: they park an {@link AppConfirmations} entry and send
 * the browser to this page. `GET` renders "Sign in the CamStack app as <user>?";
 * `POST` (Continue) spends the one-shot, cookie-bound token and ONLY THEN mints
 * the handoff code and answers `{ location }` at the app's scheme. Nothing is
 * minted without the POST, and the token is useless in any other browser.
 */
import { appFlowLocation } from '@camstack/types'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { HandoffCodeService } from '../core/auth/handoff-code.service.js'
import {
  APP_CONFIRM_COOKIE,
  type AppConfirmation,
  type AppConfirmations,
} from './app-confirmations.js'
import {
  APP_CONFIRM_CSP,
  APP_CONFIRM_REFUSAL_CSP,
  appConfirmPage,
  appConfirmRefusalPage,
} from './app-confirm-page.js'
import { resolveAppPageLang } from './app-page-strings.js'
import type { AuthNetworkPolicy } from './auth-network-policy.js'
import { clientKeyFromRequest, type RateLimiter } from './auth-rate-limit.js'
import { readCookie } from './sso-finish-deps.js'

export const APP_CONFIRM_PATH = '/auth/app/confirm'
/** The query parameter carrying the token (masked in logged URLs). */
export const APP_CONFIRM_PARAM = 'confirm'

/** `Set-Cookie` for the browser binding: HttpOnly, Lax (the entry may come from a cross-site redirect chain). */
export function appConfirmCookie(value: string, secure: boolean): string {
  return [
    `${APP_CONFIRM_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=180',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export interface AppConfirmLogger {
  warn(
    message: string,
    options?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> },
  ): void
  info?(
    message: string,
    options?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> },
  ): void
}

export interface AppConfirmDeps {
  readonly confirmations: AppConfirmations
  readonly handoffCodes: Pick<HandoffCodeService, 'create'>
  readonly network: AuthNetworkPolicy
  readonly limiter: RateLimiter
  readonly logger: AppConfirmLogger
}

const ConfirmBodySchema = z.object({ confirm: z.string().min(1).max(256) })

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store')
  reply.header('Referrer-Policy', 'no-referrer')
}

/** The handoff code, minted for a confirmed person. */
function mint(deps: AppConfirmDeps, confirmation: AppConfirmation): string {
  const { app } = confirmation
  const minted = deps.handoffCodes.create(confirmation.userId, {
    purpose: app.purpose,
    codeChallenge: app.codeChallenge,
    state: app.state,
    authMethod: confirmation.authMethod,
  })
  return appFlowLocation(app.redirect, { code: minted.code }, app.state)
}

export function registerAppConfirmRoutes(fastify: FastifyInstance, deps: AppConfirmDeps): void {
  const limited = (request: unknown, reply: FastifyReply): boolean => {
    const client = clientKeyFromRequest(request, deps.network)
    if (client === null) return false
    const verdict = deps.limiter.check(`app-confirm:${client}`)
    if (verdict.allowed) return false
    reply.header('retry-after', String(verdict.retryAfterSeconds))
    void reply.status(429).send({ error: 'Too many attempts' })
    return true
  }

  fastify.get<{ Querystring: Record<string, string | undefined> }>(
    APP_CONFIRM_PATH,
    async (request, reply) => {
      noStore(reply)
      reply.type('text/html; charset=utf-8')
      if (limited(request, reply)) return reply
      const token = request.query[APP_CONFIRM_PARAM]
      const confirmation =
        token === undefined
          ? null
          : deps.confirmations.peek(token, readCookie(request.headers.cookie, APP_CONFIRM_COOKIE))
      if (token === undefined || confirmation === null) {
        deps.logger.warn('App sign-in confirmation page refused', {
          meta: { reason: 'unknown-expired-or-other-browser' },
        })
        reply.header('Content-Security-Policy', APP_CONFIRM_REFUSAL_CSP)
        return reply
          .status(400)
          .send(
            appConfirmRefusalPage(
              resolveAppPageLang({ acceptLanguage: request.headers['accept-language'] }),
            ),
          )
      }
      reply.header('Content-Security-Policy', APP_CONFIRM_CSP)
      return reply.send(
        appConfirmPage({
          lang: resolveAppPageLang({
            lang: confirmation.app.lang,
            acceptLanguage: request.headers['accept-language'],
          }),
          username: confirmation.username,
          token,
          cancelHref: appFlowLocation(
            confirmation.app.redirect,
            { error: 'cancelled' },
            confirmation.app.state,
          ),
        }),
      )
    },
  )

  fastify.post(APP_CONFIRM_PATH, async (request, reply) => {
    noStore(reply)
    if (limited(request, reply)) return reply
    const body = ConfirmBodySchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Malformed confirmation.' })
    const confirmation = deps.confirmations.consume(
      body.data.confirm,
      readCookie(request.headers.cookie, APP_CONFIRM_COOKIE),
    )
    if (confirmation === null) {
      deps.logger.warn('App sign-in confirmation refused', {
        meta: { reason: 'unknown-used-expired-or-other-browser' },
      })
      return reply.status(400).send({ error: 'This confirmation expired.' })
    }
    deps.logger.info?.('App sign-in confirmed', {
      tags: { userId: confirmation.userId },
      meta: { method: confirmation.authMethod, purpose: confirmation.app.purpose },
    })
    return reply.send({ location: mint(deps, confirmation) })
  })
}
